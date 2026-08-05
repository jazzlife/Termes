#include "connectorbackend.h"

#include "credentialstore.h"
#include "platformadapter.h"

#include <QCryptographicHash>
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QFutureWatcher>
#include <QJsonArray>
#include <QJsonDocument>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QProcess>
#include <QRegularExpression>
#include <QSaveFile>
#include <QSettings>
#include <QStandardPaths>
#include <QSysInfo>
#include <QUrlQuery>
#include <QUuid>
#include <QtConcurrent>

namespace {
constexpr int ProtocolVersion = 1;
constexpr qint64 MaxWebSocketMessageBytes = 1024 * 1024;
constexpr qint64 MaxPairingResponseBytes = 1024 * 1024;

bool validCommandId(const QString &commandId)
{
    static const QRegularExpression uuidPattern(QStringLiteral(
        "^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$"));
    return commandId.size() == 36 && uuidPattern.match(commandId).hasMatch();
}

QString timestamp()
{
    return QDateTime::currentDateTimeUtc().toString(Qt::ISODateWithMs);
}

QByteArray encodeJsonValue(const QJsonValue &value)
{
    QJsonArray wrapper;
    wrapper.append(value);
    QByteArray encoded = QJsonDocument(wrapper).toJson(QJsonDocument::Compact);
    return encoded.mid(1, encoded.size() - 2);
}

int skipWhitespace(const QByteArray &json, int offset)
{
    while (offset < json.size()
           && (json[offset] == ' ' || json[offset] == '\t'
               || json[offset] == '\r' || json[offset] == '\n')) {
        ++offset;
    }
    return offset;
}

int jsonStringEnd(const QByteArray &json, int offset)
{
    if (offset >= json.size() || json[offset] != '"') return -1;
    bool escaped = false;
    for (int index = offset + 1; index < json.size(); ++index) {
        const char current = json[index];
        if (escaped) {
            escaped = false;
        } else if (current == '\\') {
            escaped = true;
        } else if (current == '"') {
            return index + 1;
        }
    }
    return -1;
}

int jsonValueEnd(const QByteArray &json, int offset)
{
    if (offset >= json.size()) return -1;
    if (json[offset] == '"') return jsonStringEnd(json, offset);
    if (json[offset] != '{' && json[offset] != '[') {
        int index = offset;
        while (index < json.size() && json[index] != ',' && json[index] != '}') ++index;
        return skipWhitespace(json, offset) == index ? -1 : index;
    }
    QList<char> closing;
    closing.append(json[offset] == '{' ? '}' : ']');
    bool inString = false;
    bool escaped = false;
    for (int index = offset + 1; index < json.size(); ++index) {
        const char current = json[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (current == '\\') escaped = true;
            else if (current == '"') inString = false;
            continue;
        }
        if (current == '"') {
            inString = true;
        } else if (current == '{') {
            closing.append('}');
        } else if (current == '[') {
            closing.append(']');
        } else if (!closing.isEmpty() && current == closing.constLast()) {
            closing.removeLast();
            if (closing.isEmpty()) return index + 1;
        }
    }
    return -1;
}

QByteArray topLevelRawValue(const QByteArray &json, const QString &targetKey)
{
    int offset = skipWhitespace(json, 0);
    if (offset >= json.size() || json[offset++] != '{') return {};
    while (offset < json.size()) {
        offset = skipWhitespace(json, offset);
        if (offset >= json.size() || json[offset] == '}') break;
        const int keyStart = offset;
        const int keyEnd = jsonStringEnd(json, keyStart);
        if (keyEnd < 0) return {};
        const QJsonDocument keyDocument = QJsonDocument::fromJson(
            QByteArrayLiteral("[") + json.mid(keyStart, keyEnd - keyStart) + QByteArrayLiteral("]"));
        if (!keyDocument.isArray() || keyDocument.array().isEmpty()) return {};
        const QString key = keyDocument.array().first().toString();
        offset = skipWhitespace(json, keyEnd);
        if (offset >= json.size() || json[offset++] != ':') return {};
        offset = skipWhitespace(json, offset);
        const int valueStart = offset;
        const int valueEnd = jsonValueEnd(json, valueStart);
        if (valueEnd < 0) return {};
        if (key == targetKey) return json.mid(valueStart, valueEnd - valueStart).trimmed();
        offset = skipWhitespace(json, valueEnd);
        if (offset < json.size() && json[offset] == ',') ++offset;
    }
    return {};
}

bool hasDuplicateTopLevelKeys(const QByteArray &json)
{
    int offset = skipWhitespace(json, 0);
    if (offset >= json.size() || json[offset++] != '{') return false;
    QSet<QString> keys;
    while (offset < json.size()) {
        offset = skipWhitespace(json, offset);
        if (offset < json.size() && json[offset] == '}') return false;
        const int keyStart = offset;
        const int keyEnd = jsonStringEnd(json, keyStart);
        if (keyEnd < 0) return false;
        const QJsonDocument keyDocument = QJsonDocument::fromJson(
            QByteArrayLiteral("[") + json.mid(keyStart, keyEnd - keyStart) + QByteArrayLiteral("]"));
        if (!keyDocument.isArray() || keyDocument.array().isEmpty()) return false;
        const QString key = keyDocument.array().first().toString();
        if (keys.contains(key)) return true;
        keys.insert(key);
        offset = skipWhitespace(json, keyEnd);
        if (offset >= json.size() || json[offset++] != ':') return false;
        offset = skipWhitespace(json, offset);
        const int valueEnd = jsonValueEnd(json, offset);
        if (valueEnd < 0) return false;
        offset = skipWhitespace(json, valueEnd);
        if (offset < json.size() && json[offset] == ',') ++offset;
    }
    return false;
}

QDateTime commandDeadline(const QJsonObject &envelope)
{
    const QString value = envelope.value(QStringLiteral("deadline")).toString();
    QDateTime deadline = QDateTime::fromString(value, Qt::ISODateWithMs);
    if (!deadline.isValid()) deadline = QDateTime::fromString(value, Qt::ISODate);
    return deadline.toUTC();
}

bool deadlineAllowsExecution(const QJsonObject &envelope, const QDateTime &now = QDateTime::currentDateTimeUtc())
{
    const QDateTime deadline = commandDeadline(envelope);
    if (!deadline.isValid()) return false;
    const QString action = envelope.value(QStringLiteral("action")).toString();
    return now.msecsTo(deadline) >= PlatformAdapter::executionBudgetMs(action);
}

QString apiError(const QByteArray &body, const QString &fallback)
{
    const QJsonDocument document = QJsonDocument::fromJson(body);
    const QString message = document.object().value(QStringLiteral("error")).toString();
    return message.isEmpty() ? fallback : message;
}
}

ConnectorBackend::ConnectorBackend(QObject *parent)
    : QObject(parent)
{
    m_permissions = PlatformAdapter::permissionState();
    m_heartbeatTimer.setInterval(10'000);
    m_reconnectTimer.setSingleShot(true);
    m_connectTimeout.setSingleShot(true);
    m_connectTimeout.setInterval(30'000);
    m_webSocket.setMaxAllowedIncomingMessageSize(MaxWebSocketMessageBytes);

    connect(&m_heartbeatTimer, &QTimer::timeout, this, &ConnectorBackend::sendHeartbeat);
    connect(&m_reconnectTimer, &QTimer::timeout, this, &ConnectorBackend::connectConnector);
    connect(&m_connectTimeout, &QTimer::timeout, this, [this] {
        if (m_webSocket.state() == QAbstractSocket::ConnectingState) {
            m_webSocket.abort();
            setPhase(QStringLiteral("error"), QStringLiteral("Connector 연결 시간이 제한을 초과했습니다."));
            scheduleReconnect();
        }
    });
    connect(&m_webSocket, &QWebSocket::connected, this, [this] {
        if (m_webSocket.state() != QAbstractSocket::ConnectedState) return;
        m_connectTimeout.stop();
        m_reconnectBackoffSeconds = 2;
        ++m_sessionGeneration;
        m_lastCommandSequence = 0;
        m_seenCommandIds.clear();
        m_seenCommandOrder.clear();
        setPhase(QStringLiteral("online"));
        sendHello();
        sendHeartbeat();
        m_heartbeatTimer.start();
        addActivity(QStringLiteral("connection"), QStringLiteral("Connected"),
                    QStringLiteral("%1 / %2")
                        .arg(m_settings.value(QStringLiteral("workspaceKey")).toString(),
                             m_settings.value(QStringLiteral("projectName")).toString()),
                    true);
    });
    connect(&m_webSocket, &QWebSocket::textMessageReceived,
            this, &ConnectorBackend::handleWebSocketMessage);
    connect(&m_webSocket, &QWebSocket::disconnected,
            this, &ConnectorBackend::handleWebSocketDisconnected);
    connect(&m_webSocket, &QWebSocket::errorOccurred, this, [this](QAbstractSocket::SocketError) {
        if (m_manualDisconnect) return;
        const QString message = QStringLiteral("Connector WebSocket 오류: %1").arg(m_webSocket.errorString());
        setPhase(QStringLiteral("error"), message);
        if (m_webSocket.state() == QAbstractSocket::UnconnectedState) scheduleReconnect();
    });

    loadSettings();
    QTimer::singleShot(0, this, [this] {
        if (paired()) connectConnector();
    });
}

QString ConnectorBackend::defaultDeviceName() const
{
    const QString name = QSysInfo::machineHostName().trimmed();
    if (!name.isEmpty()) return name;
    return PlatformAdapter::platformName() == QLatin1String("macos")
        ? QStringLiteral("My Mac") : QStringLiteral("My Windows PC");
}

QString ConnectorBackend::settingsPath() const
{
    QString directory = qEnvironmentVariable("TERMES_CONNECTOR_QT_DATA_DIR").trimmed();
    if (directory.isEmpty()) {
        directory = QStandardPaths::writableLocation(QStandardPaths::AppDataLocation);
    }
    QDir().mkpath(directory);
    return QDir(directory).filePath(QStringLiteral("connector.json"));
}

void ConnectorBackend::loadSettings()
{
    QFile file(settingsPath());
    if (!file.exists()) {
        m_phase = QStringLiteral("unpaired");
        return;
    }
    if (!file.open(QIODevice::ReadOnly)) {
        setPhase(QStringLiteral("error"), QStringLiteral("Connector 설정을 읽을 수 없습니다: %1").arg(file.errorString()));
        return;
    }
    QJsonParseError parseError;
    const QJsonDocument document = QJsonDocument::fromJson(file.readAll(), &parseError);
    if (parseError.error != QJsonParseError::NoError || !document.isObject()) {
        setPhase(QStringLiteral("error"), QStringLiteral("Connector 설정이 유효하지 않습니다: %1").arg(parseError.errorString()));
        return;
    }
    QVariantMap settings = document.object().toVariantMap();
    QString normalizationError;
    const QString storedBase = settings.value(QStringLiteral("apiBaseUrl")).toString();
    const QString normalizedBase = normalizeApiBaseUrl(storedBase, &normalizationError);
    if (normalizedBase.isEmpty()) {
        m_settings.clear();
        setPhase(QStringLiteral("error"),
                 QStringLiteral("저장된 Termes 주소가 안전하지 않습니다: %1").arg(normalizationError));
        return;
    }
    settings.insert(QStringLiteral("apiBaseUrl"), normalizedBase);
    m_settings = settings;
    if (normalizedBase != storedBase) {
        QString saveError;
        if (!saveSettings(&saveError)) {
            m_settings.clear();
            setPhase(QStringLiteral("error"), saveError);
            return;
        }
    }
    m_phase = QStringLiteral("offline");
}

bool ConnectorBackend::saveSettings(QString *error) const
{
    QSaveFile file(settingsPath());
    if (!file.open(QIODevice::WriteOnly)) {
        if (error) *error = QStringLiteral("Connector 설정을 쓸 수 없습니다: %1").arg(file.errorString());
        return false;
    }
    file.write(QJsonDocument(QJsonObject::fromVariantMap(m_settings)).toJson(QJsonDocument::Indented));
    if (!file.commit()) {
        if (error) *error = QStringLiteral("Connector 설정을 교체할 수 없습니다: %1").arg(file.errorString());
        return false;
    }
    return true;
}

bool ConnectorBackend::removeSettings(QString *error) const
{
    const QString path = settingsPath();
    if (!QFile::exists(path) || QFile::remove(path)) return true;
    if (error) *error = QStringLiteral("Connector 설정을 제거할 수 없습니다.");
    return false;
}

QString ConnectorBackend::machineFingerprint() const
{
    QString machineId;
#ifdef Q_OS_MACOS
    QProcess ioreg;
    ioreg.start(QStringLiteral("/usr/sbin/ioreg"),
                {QStringLiteral("-rd1"), QStringLiteral("-c"),
                 QStringLiteral("IOPlatformExpertDevice")});
    if (ioreg.waitForFinished(5'000) && ioreg.exitCode() == 0) {
        static const QRegularExpression uuidPattern(
            QStringLiteral("\\\"IOPlatformUUID\\\"\\s*=\\s*\\\"([^\\\"]+)\\\""));
        const auto match = uuidPattern.match(QString::fromUtf8(ioreg.readAllStandardOutput()));
        if (match.hasMatch()) machineId = match.captured(1);
    }
#elif defined(Q_OS_WIN)
    QSettings registry(
        QStringLiteral("HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography"),
        QSettings::NativeFormat);
    machineId = registry.value(QStringLiteral("MachineGuid")).toString().trimmed();
#endif
    if (machineId.isEmpty()) {
        machineId = QSysInfo::machineHostName() + QLatin1Char(':')
            + qEnvironmentVariable("USER", qEnvironmentVariable("USERNAME"))
            + QLatin1Char(':') + PlatformAdapter::actionPrefix();
    }
    const QByteArray stable = machineId.toUtf8();
    return PlatformAdapter::actionPrefix() + QLatin1Char(':')
        + QString::fromLatin1(QCryptographicHash::hash(stable, QCryptographicHash::Sha256).toHex());
}

QString ConnectorBackend::normalizeApiBaseUrl(const QString &value, QString *error)
{
    if (error) error->clear();
    QUrl url = QUrl::fromUserInput(value.trimmed());
    if (!url.isValid() || url.host().isEmpty()) {
        if (error) *error = QStringLiteral("Termes 주소가 유효하지 않습니다.");
        return {};
    }
    if (!url.userName().isEmpty() || !url.password().isEmpty()) {
        if (error) *error = QStringLiteral("Termes 주소에는 사용자 이름 또는 비밀번호를 포함할 수 없습니다.");
        return {};
    }
    const bool loopback = url.host() == QLatin1String("localhost")
        || url.host() == QLatin1String("127.0.0.1") || url.host() == QLatin1String("::1");
    if (url.scheme() != QLatin1String("https") && !(url.scheme() == QLatin1String("http") && loopback)) {
        if (error) *error = QStringLiteral("원격 Termes 연결은 HTTPS가 필요합니다.");
        return {};
    }
    url.setPath(QString());
    url.setQuery(QString());
    url.setFragment(QString());
    QString normalized = url.toString(QUrl::RemovePath | QUrl::RemoveQuery | QUrl::RemoveFragment).trimmed();
    while (normalized.endsWith(QLatin1Char('/'))) normalized.chop(1);
    return normalized;
}

void ConnectorBackend::pairConnector(const QString &apiBaseUrl,
                                     const QString &pairingCode,
                                     const QString &deviceName)
{
    if (m_actionBusy) return;
    QString validationError;
    const QString base = normalizeApiBaseUrl(apiBaseUrl, &validationError);
    const QString name = deviceName.trimmed();
    const QString code = pairingCode.trimmed().toUpper();
    if (name.isEmpty() || name.size() > 120) validationError = QStringLiteral("PC 이름은 1~120자여야 합니다.");
    if (code.size() < 8 || code.size() > 32) validationError = QStringLiteral("일회용 코드를 확인해 주세요.");
    if (!validationError.isEmpty()) {
        setPhase(QStringLiteral("unpaired"), validationError);
        return;
    }

    disconnectConnector();
    const quint64 pairingGeneration = ++m_pairingGeneration;
    m_actionBusy = true;
    setPhase(QStringLiteral("connecting"));
    emit stateChanged();

    QNetworkRequest request(QUrl(base + QStringLiteral("/api/desktop-connectors/pair")));
    request.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    request.setTransferTimeout(30'000);
    QJsonObject payload{
        {QStringLiteral("pairingCode"), code},
        {QStringLiteral("name"), name},
        {QStringLiteral("platform"), PlatformAdapter::platformName()},
        {QStringLiteral("machineFingerprint"), machineFingerprint()},
        {QStringLiteral("publicKey"), QJsonValue::Null},
        {QStringLiteral("appVersion"), QCoreApplication::applicationVersion()},
        {QStringLiteral("capabilities"), QJsonArray::fromStringList(PlatformAdapter::capabilities())},
        {QStringLiteral("permissions"), QJsonObject::fromVariantMap(PlatformAdapter::permissionState())},
    };
    QNetworkReply *reply = m_network.post(request, QJsonDocument(payload).toJson(QJsonDocument::Compact));
    reply->setReadBufferSize(MaxPairingResponseBytes + 1);
    m_pairingReply = reply;
    connect(reply, &QNetworkReply::finished, this, [this, reply, base, name, pairingGeneration] {
        if (m_pairingReply == reply) m_pairingReply.clear();
        if (pairingGeneration != m_pairingGeneration) {
            reply->deleteLater();
            return;
        }
        m_actionBusy = false;
        QByteArray body;
        if (reply->bytesAvailable() <= MaxPairingResponseBytes) {
            body = reply->read(MaxPairingResponseBytes + 1);
        }
        if (reply->bytesAvailable() > 0 || body.size() > MaxPairingResponseBytes) {
            reply->abort();
            reply->deleteLater();
            setPhase(QStringLiteral("unpaired"), QStringLiteral("페어링 응답이 크기 제한을 초과했습니다."));
            return;
        }
        if (reply->error() != QNetworkReply::NoError) {
            const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
            const QString message = apiError(body,
                status > 0 ? QStringLiteral("페어링 실패 (%1)").arg(status) : reply->errorString());
            reply->deleteLater();
            setPhase(QStringLiteral("unpaired"), message);
            emit stateChanged();
            return;
        }
        const QJsonDocument document = QJsonDocument::fromJson(body);
        const QJsonObject response = document.object();
        const QString connectorId = response.value(QStringLiteral("connectorId")).toString();
        const QString deviceToken = response.value(QStringLiteral("deviceToken")).toString();
        if (connectorId.isEmpty() || deviceToken.isEmpty()) {
            reply->deleteLater();
            setPhase(QStringLiteral("unpaired"), QStringLiteral("Termes가 유효하지 않은 페어링 응답을 반환했습니다."));
            emit stateChanged();
            return;
        }
        QString storeError;
        if (!CredentialStore::save(connectorId, deviceToken, &storeError)) {
            reply->deleteLater();
            setPhase(QStringLiteral("unpaired"), storeError);
            emit stateChanged();
            return;
        }
        m_settings = {
            {QStringLiteral("apiBaseUrl"), base},
            {QStringLiteral("connectorId"), connectorId},
            {QStringLiteral("deviceId"), response.value(QStringLiteral("deviceId")).toString()},
            {QStringLiteral("accountId"), response.value(QStringLiteral("accountId")).toString()},
            {QStringLiteral("workspaceId"), response.value(QStringLiteral("workspaceId")).toString()},
            {QStringLiteral("workspaceKey"), response.value(QStringLiteral("workspaceKey")).toString()},
            {QStringLiteral("projectId"), response.value(QStringLiteral("projectId")).toString()},
            {QStringLiteral("projectName"), response.value(QStringLiteral("projectName")).toString()},
            {QStringLiteral("deviceName"), name},
            {QStringLiteral("platform"), PlatformAdapter::platformName()},
            {QStringLiteral("autoObserve"), false},
        };
        QString saveError;
        if (!saveSettings(&saveError)) {
            CredentialStore::remove(connectorId);
            m_settings.clear();
            reply->deleteLater();
            setPhase(QStringLiteral("unpaired"), saveError);
            emit stateChanged();
            return;
        }
        reply->deleteLater();
        setPhase(QStringLiteral("offline"));
        addActivity(QStringLiteral("pairing"), QStringLiteral("Workspace connected"),
                    QStringLiteral("%1 / %2")
                        .arg(m_settings.value(QStringLiteral("workspaceKey")).toString(),
                             m_settings.value(QStringLiteral("projectName")).toString()), true);
        connectConnector();
    });
}

QString ConnectorBackend::token(QString *error) const
{
    const QString connectorId = m_settings.value(QStringLiteral("connectorId")).toString();
    if (connectorId.isEmpty()) {
        if (error) *error = QStringLiteral("먼저 이 PC를 페어링해야 합니다.");
        return {};
    }
    return CredentialStore::load(connectorId, error);
}

QUrl ConnectorBackend::websocketUrl(QString *error) const
{
    if (error) error->clear();
    QString normalizationError;
    const QString normalizedBase = normalizeApiBaseUrl(
        m_settings.value(QStringLiteral("apiBaseUrl")).toString(), &normalizationError);
    if (normalizedBase.isEmpty()) {
        if (error) {
            *error = QStringLiteral("저장된 Termes 주소가 안전하지 않습니다: %1")
                         .arg(normalizationError);
        }
        return {};
    }
    QUrl url(normalizedBase);
    if (url.scheme() == QLatin1String("https")) url.setScheme(QStringLiteral("wss"));
    else if (url.scheme() == QLatin1String("http")) url.setScheme(QStringLiteral("ws"));
    else {
        if (error) *error = QStringLiteral("저장된 Termes 주소의 스킴을 지원하지 않습니다.");
        return {};
    }
    url.setPath(QStringLiteral("/api/desktop-connectors/connect"));
    QUrlQuery query;
    query.addQueryItem(QStringLiteral("connectorId"), m_settings.value(QStringLiteral("connectorId")).toString());
    url.setQuery(query);
    return url;
}

void ConnectorBackend::connectConnector()
{
    if (!paired()) return;
    const SocketConnectAction connectAction = socketConnectAction(
        m_webSocket.state(), m_socketCycleActive);
    if (connectAction == SocketConnectAction::Ignore) return;
    m_manualDisconnect = false;
    m_reconnectTimer.stop();
    if (connectAction == SocketConnectAction::WaitForDisconnected) {
        m_connectAfterDisconnect = true;
        setPhase(QStringLiteral("connecting"));
        return;
    }
    m_connectAfterDisconnect = false;
    QString error;
    const QUrl url = websocketUrl(&error);
    if (!error.isEmpty() || !url.isValid()) {
        setPhase(QStringLiteral("error"), error.isEmpty()
            ? QStringLiteral("저장된 Termes 주소가 유효하지 않습니다.") : error);
        return;
    }
    const QString credential = token(&error);
    if (!error.isEmpty() || credential.isEmpty()) {
        setPhase(QStringLiteral("error"), error.isEmpty()
            ? QStringLiteral("Connector 자격 증명이 없습니다.") : error);
        return;
    }
    setPhase(QStringLiteral("connecting"));
    QNetworkRequest request(url);
    request.setRawHeader("Authorization", QByteArrayLiteral("Bearer ") + credential.toUtf8());
    m_socketCycleActive = true;
    m_webSocket.open(request);
    m_connectTimeout.start();
}

void ConnectorBackend::disconnectConnector()
{
    ++m_sessionGeneration;
    ++m_executionGeneration;
    cancelActiveExecution();
    m_manualDisconnect = true;
    m_connectAfterDisconnect = false;
    m_reconnectTimer.stop();
    m_connectTimeout.stop();
    m_heartbeatTimer.stop();
    rejectAllPending(QStringLiteral("로컬에서 연결을 종료했습니다."));
    if (m_webSocket.state() != QAbstractSocket::UnconnectedState) {
        m_webSocket.close(QWebSocketProtocol::CloseCodeNormal, QStringLiteral("local disconnect"));
    }
    setPhase(paired() ? QStringLiteral("offline") : QStringLiteral("unpaired"));
}

ConnectorBackend::SocketConnectAction ConnectorBackend::socketConnectAction(
    QAbstractSocket::SocketState state, bool socketCycleActive)
{
    if (state == QAbstractSocket::UnconnectedState && !socketCycleActive)
        return SocketConnectAction::Open;
    if (state == QAbstractSocket::ClosingState
        || (state == QAbstractSocket::UnconnectedState && socketCycleActive))
        return SocketConnectAction::WaitForDisconnected;
    return SocketConnectAction::Ignore;
}

void ConnectorBackend::handleWebSocketDisconnected()
{
    if (m_webSocket.state() != QAbstractSocket::UnconnectedState) return;
    m_socketCycleActive = false;
    m_connectTimeout.stop();
    m_heartbeatTimer.stop();
    ++m_sessionGeneration;
    ++m_executionGeneration;
    cancelActiveExecution();
    rejectAllPending(QStringLiteral("Connector 연결이 종료되었습니다."));

    const bool connectAfterDisconnect = m_connectAfterDisconnect;
    m_connectAfterDisconnect = false;
    if (connectAfterDisconnect) {
        setPhase(paired() ? QStringLiteral("offline") : QStringLiteral("unpaired"));
        QTimer::singleShot(0, this, [this] {
            if (paired() && m_webSocket.state() == QAbstractSocket::UnconnectedState)
                connectConnector();
        });
        return;
    }
    if (m_manualDisconnect || !paired()) {
        setPhase(paired() ? QStringLiteral("offline") : QStringLiteral("unpaired"));
        return;
    }
    const bool revoked = m_webSocket.closeCode() == QWebSocketProtocol::CloseCode(4001);
    const QString reason = revoked
        ? QStringLiteral("credential_revoked: Termes가 이 Connector의 자격 증명을 폐기했습니다.")
        : QStringLiteral("Connector WebSocket 연결이 종료되었습니다: %1")
              .arg(m_webSocket.closeReason().isEmpty() ? QStringLiteral("close frame 없음") : m_webSocket.closeReason());
    setPhase(QStringLiteral("error"), reason);
    addActivity(QStringLiteral("connection"), QStringLiteral("Connection lost"), reason, false);
    if (!revoked) scheduleReconnect();
}

void ConnectorBackend::forgetConnector()
{
    cancelPairing();
    const QString connectorId = m_settings.value(QStringLiteral("connectorId")).toString();
    disconnectConnector();
    QString error;
    if (!connectorId.isEmpty() && !CredentialStore::remove(connectorId, &error)) {
        setPhase(QStringLiteral("error"), error);
        return;
    }
    if (!removeSettings(&error)) {
        setPhase(QStringLiteral("error"), error);
        return;
    }
    m_settings.clear();
    setPhase(QStringLiteral("unpaired"));
    addActivity(QStringLiteral("pairing"), QStringLiteral("Local pairing removed"),
                QStringLiteral("이 앱은 더 이상 장치 자격 증명을 보유하지 않습니다."), true);
}

void ConnectorBackend::setAutoObserve(bool enabled)
{
    if (!paired()) return;
    m_settings.insert(QStringLiteral("autoObserve"), enabled);
    QString error;
    if (!saveSettings(&error)) setPhase(QStringLiteral("error"), error);
    emit stateChanged();
}

void ConnectorBackend::refreshPermissions()
{
    m_permissions = PlatformAdapter::permissionState();
    emit stateChanged();
}

void ConnectorBackend::requestPermission(const QString &kind)
{
    QString error;
    if (!PlatformAdapter::requestPermission(kind, &error) && !error.isEmpty()) m_lastError = error;
    QTimer::singleShot(500, this, &ConnectorBackend::refreshPermissions);
    emit stateChanged();
}

void ConnectorBackend::openPermissionSettings(const QString &kind)
{
    QString error;
    if (!PlatformAdapter::openPermissionSettings(kind, &error)) m_lastError = error;
    emit stateChanged();
}

void ConnectorBackend::clearError()
{
    m_lastError.clear();
    emit stateChanged();
}

void ConnectorBackend::setPhase(const QString &phase, const QString &error)
{
    m_phase = phase;
    m_lastError = error;
    emit stateChanged();
}

void ConnectorBackend::addActivity(const QString &kind,
                                   const QString &title,
                                   const QString &detail,
                                   const QVariant &success)
{
    QVariantMap entry{{QStringLiteral("id"), QUuid::createUuid().toString(QUuid::WithoutBraces)},
                      {QStringLiteral("at"), timestamp()},
                      {QStringLiteral("kind"), kind},
                      {QStringLiteral("title"), title},
                      {QStringLiteral("detail"), detail},
                      {QStringLiteral("success"), success}};
    m_activities.prepend(entry);
    while (m_activities.size() > 50) m_activities.removeLast();
    emit stateChanged();
}

void ConnectorBackend::scheduleReconnect()
{
    if (m_manualDisconnect || !paired() || m_reconnectTimer.isActive()) return;
    m_reconnectTimer.start(m_reconnectBackoffSeconds * 1000);
    m_reconnectBackoffSeconds = qMin(m_reconnectBackoffSeconds * 2, 30);
}

void ConnectorBackend::sendJson(const QJsonObject &message)
{
    if (m_webSocket.state() != QAbstractSocket::ConnectedState) return;
    m_webSocket.sendTextMessage(QString::fromUtf8(QJsonDocument(message).toJson(QJsonDocument::Compact)));
}

void ConnectorBackend::sendHello()
{
    sendJson({{QStringLiteral("type"), QStringLiteral("hello")},
              {QStringLiteral("protocolVersion"), ProtocolVersion},
              {QStringLiteral("appVersion"), QCoreApplication::applicationVersion()},
              {QStringLiteral("capabilities"), QJsonArray::fromStringList(PlatformAdapter::capabilities())},
              {QStringLiteral("permissions"), QJsonObject::fromVariantMap(PlatformAdapter::permissionState())}});
}

void ConnectorBackend::sendHeartbeat()
{
    m_permissions = PlatformAdapter::permissionState();
    sendJson({{QStringLiteral("type"), QStringLiteral("heartbeat")},
              {QStringLiteral("sentAt"), timestamp()},
              {QStringLiteral("capabilities"), QJsonArray::fromStringList(PlatformAdapter::capabilities())},
              {QStringLiteral("permissions"), QJsonObject::fromVariantMap(m_permissions)}});
    emit stateChanged();
}

void ConnectorBackend::handleWebSocketMessage(const QString &message)
{
    const QByteArray wireMessage = message.toUtf8();
    if (wireMessage.size() > MaxWebSocketMessageBytes) {
        setPhase(QStringLiteral("error"), QStringLiteral("Termes Connector 메시지가 크기 제한을 초과했습니다."));
        m_webSocket.close(QWebSocketProtocol::CloseCodeTooMuchData, QStringLiteral("message too large"));
        return;
    }
    QJsonParseError error;
    const QJsonDocument document = QJsonDocument::fromJson(wireMessage, &error);
    if (error.error != QJsonParseError::NoError || !document.isObject()) {
        setPhase(QStringLiteral("error"), QStringLiteral("Termes가 유효하지 않은 Connector JSON을 보냈습니다."));
        m_webSocket.close(QWebSocketProtocol::CloseCodeProtocolError, QStringLiteral("invalid JSON"));
        return;
    }
    const QJsonObject object = document.object();
    if (hasDuplicateTopLevelKeys(wireMessage)) {
        setPhase(QStringLiteral("error"), QStringLiteral("Termes가 중복 최상위 키를 포함한 Connector JSON을 보냈습니다."));
        m_webSocket.close(QWebSocketProtocol::CloseCodeProtocolError, QStringLiteral("duplicate JSON key"));
        return;
    }
    const QString type = object.value(QStringLiteral("type")).toString();
    if (type == QLatin1String("connected") || type == QLatin1String("ready")
        || type == QLatin1String("heartbeat.ack")) return;
    if (type == QLatin1String("command")) {
        handleCommand(object, commandRequestHashFromWire(wireMessage));
        return;
    }
    setPhase(QStringLiteral("error"), QStringLiteral("Termes가 지원하지 않는 메시지를 보냈습니다: %1").arg(type));
    m_webSocket.close(QWebSocketProtocol::CloseCodeProtocolError, QStringLiteral("unsupported message"));
}

QByteArray ConnectorBackend::commandRequestHash(const QJsonObject &envelope)
{
    const QByteArray canonical = QByteArrayLiteral("{\"commandId\":")
        + encodeJsonValue(envelope.value(QStringLiteral("commandId")))
        + QByteArrayLiteral(",\"sequence\":")
        + QByteArray::number(envelope.value(QStringLiteral("sequence")).toInteger())
        + QByteArrayLiteral(",\"action\":")
        + encodeJsonValue(envelope.value(QStringLiteral("action")))
        + QByteArrayLiteral(",\"params\":")
        + encodeJsonValue(envelope.value(QStringLiteral("params")))
        + QByteArrayLiteral("}");
    return QCryptographicHash::hash(canonical, QCryptographicHash::Sha256).toHex();
}

QByteArray ConnectorBackend::commandRequestHashFromWire(const QByteArray &message)
{
    if (hasDuplicateTopLevelKeys(message)) return {};
    const QByteArray commandId = topLevelRawValue(message, QStringLiteral("commandId"));
    const QByteArray sequence = topLevelRawValue(message, QStringLiteral("sequence"));
    const QByteArray action = topLevelRawValue(message, QStringLiteral("action"));
    const QByteArray params = topLevelRawValue(message, QStringLiteral("params"));
    if (commandId.isEmpty() || sequence.isEmpty() || action.isEmpty() || params.isEmpty()) return {};
    const QByteArray canonical = QByteArrayLiteral("{\"commandId\":") + commandId
        + QByteArrayLiteral(",\"sequence\":") + sequence
        + QByteArrayLiteral(",\"action\":") + action
        + QByteArrayLiteral(",\"params\":") + params
        + QByteArrayLiteral("}");
    return QCryptographicHash::hash(canonical, QCryptographicHash::Sha256).toHex();
}

void ConnectorBackend::rememberCommandId(const QString &commandId)
{
    if (m_seenCommandIds.contains(commandId)) return;
    while (m_seenCommandOrder.size() >= MaxSeenCommandIds) {
        m_seenCommandIds.remove(m_seenCommandOrder.takeFirst());
    }
    m_seenCommandIds.insert(commandId);
    m_seenCommandOrder.append(commandId);
}

void ConnectorBackend::handleCommand(const QJsonObject &envelope, const QByteArray &wireRequestHash)
{
    const QString commandId = envelope.value(QStringLiteral("commandId")).toString();
    const QString action = envelope.value(QStringLiteral("action")).toString();
    const QString requestHash = envelope.value(QStringLiteral("requestHash")).toString();
    const QJsonValue sequenceValue = envelope.value(QStringLiteral("sequence"));
    const qint64 sequence = sequenceValue.toInteger(-1);
    const QDateTime deadline = commandDeadline(envelope);
    const QDateTime now = QDateTime::currentDateTimeUtc();
    QString reason;
    if (envelope.value(QStringLiteral("protocolVersion")).toInt() != ProtocolVersion)
        reason = QStringLiteral("지원하지 않는 Connector 프로토콜 버전입니다.");
    else if (!validCommandId(commandId)) reason = QStringLiteral("명령 식별자는 UUID 형식이어야 합니다.");
    else if (action.isEmpty()) reason = QStringLiteral("명령 작업이 없습니다.");
    else if (wireRequestHash.isEmpty() || wireRequestHash != requestHash.toLatin1())
        reason = QStringLiteral("명령 요청 해시가 일치하지 않습니다.");
    else if (!deadline.isValid() || deadline <= now) reason = QStringLiteral("명령 기한이 만료되었습니다.");
    else if (!PlatformAdapter::capabilities().contains(action)) reason = QStringLiteral("허용된 Connector 작업이 아닙니다.");
    else if (!deadlineAllowsExecution(envelope, now))
        reason = QStringLiteral("명령 기한에 안전한 실행 예산이 남아 있지 않습니다.");
    else if (!sequenceValue.isDouble() || sequence <= 0) reason = QStringLiteral("명령 sequence는 양수여야 합니다.");
    else if (m_seenCommandIds.contains(commandId) || m_pending.contains(commandId)
             || commandId == m_activeCommandId)
        reason = QStringLiteral("중복된 명령 식별자입니다.");
    else if (sequence <= m_lastCommandSequence) reason = QStringLiteral("명령 sequence가 단조 증가하지 않습니다.");
    if (!reason.isEmpty()) {
        sendAck(envelope, false, reason);
        addActivity(QStringLiteral("command"), QStringLiteral("Command rejected"), action + QStringLiteral(": ") + reason, false);
        return;
    }

    m_lastCommandSequence = sequence;
    if (m_actionBusy) {
        const QString busyReason = QStringLiteral("다른 Connector 명령을 실행 중입니다.");
        sendAck(envelope, false, busyReason);
        addActivity(QStringLiteral("command"), QStringLiteral("Command rejected"),
                    action + QStringLiteral(": ") + busyReason, false);
        return;
    }
    const quint64 generation = m_executionGeneration;
    if (PlatformAdapter::isReadOnly(action) && m_settings.value(QStringLiteral("autoObserve")).toBool()) {
        executeCommand(envelope, generation);
        return;
    }
    if (m_pending.size() >= MaxPendingCommands) {
        const QString capacityReason = QStringLiteral("로컬 승인 대기열이 가득 찼습니다.");
        sendAck(envelope, false, capacityReason);
        addActivity(QStringLiteral("command"), QStringLiteral("Command rejected"),
                    action + QStringLiteral(": ") + capacityReason, false);
        return;
    }

    PendingCommand pending;
    pending.envelope = envelope;
    pending.generation = generation;
    pending.requestedAt = timestamp();
    pending.timer = new QTimer(this);
    pending.timer->setSingleShot(true);
    const qint64 approvalWindow = QDateTime::currentDateTimeUtc().msecsTo(deadline)
        - PlatformAdapter::executionBudgetMs(action);
    const qint64 remaining = qBound<qint64>(qint64(0), approvalWindow, qint64(300'000));
    connect(pending.timer, &QTimer::timeout, this, [this, commandId] {
        resolveCommand(commandId, false, QStringLiteral("로컬 승인 시간이 만료되었습니다."));
    });
    pending.timer->start(int(remaining));
    rememberCommandId(commandId);
    m_pending.insert(commandId, pending);
    rebuildPendingApprovals();
}

void ConnectorBackend::rebuildPendingApprovals()
{
    m_pendingApprovals.clear();
    for (auto it = m_pending.cbegin(); it != m_pending.cend(); ++it) {
        const QJsonObject envelope = it->envelope;
        QJsonValue params = envelope.value(QStringLiteral("params"));
        const QString action = envelope.value(QStringLiteral("action")).toString();
        if (action.endsWith(QStringLiteral(".input.type"))) {
            const QString text = params.toObject().value(QStringLiteral("text")).toString();
            params = QJsonObject{{QStringLiteral("text"), QStringLiteral("[REDACTED]")},
                                 {QStringLiteral("characterCount"), text.size()}};
        }
        m_pendingApprovals.append(QVariantMap{
            {QStringLiteral("commandId"), envelope.value(QStringLiteral("commandId")).toString()},
            {QStringLiteral("sequence"), envelope.value(QStringLiteral("sequence")).toInteger()},
            {QStringLiteral("action"), action},
            {QStringLiteral("params"), params.toVariant()},
            {QStringLiteral("requestedAt"), it->requestedAt},
            {QStringLiteral("deadline"), envelope.value(QStringLiteral("deadline")).toString()},
            {QStringLiteral("readOnly"), PlatformAdapter::isReadOnly(action)},
        });
    }
    emit stateChanged();
}

void ConnectorBackend::approveCommand(const QString &commandId)
{
    resolveCommand(commandId, true);
}

void ConnectorBackend::rejectCommand(const QString &commandId)
{
    resolveCommand(commandId, false, QStringLiteral("로컬 Connector에서 거부했습니다."));
}

void ConnectorBackend::resolveCommand(const QString &commandId, bool approved, const QString &reason)
{
    auto it = m_pending.find(commandId);
    if (it == m_pending.end()) return;
    const PendingCommand pending = it.value();
    m_pending.erase(it);
    if (pending.timer) pending.timer->deleteLater();
    rebuildPendingApprovals();
    if (!approved) {
        sendAck(pending.envelope, false, reason.isEmpty() ? QStringLiteral("로컬 Connector에서 거부 또는 만료되었습니다.") : reason);
        addActivity(QStringLiteral("command"), QStringLiteral("Command denied"),
                    pending.envelope.value(QStringLiteral("action")).toString(), false);
        return;
    }
    if (pending.generation != m_executionGeneration) {
        sendAck(pending.envelope, false, QStringLiteral("로컬 긴급 중단으로 취소되었습니다."));
        return;
    }
    if (!deadlineAllowsExecution(pending.envelope)) {
        sendAck(pending.envelope, false,
                QStringLiteral("명령 기한이 만료되었거나 안전한 실행 예산이 부족합니다."));
        addActivity(QStringLiteral("command"), QStringLiteral("Command expired"),
                    pending.envelope.value(QStringLiteral("action")).toString(), false);
        return;
    }
    if (m_actionBusy) {
        sendAck(pending.envelope, false, QStringLiteral("다른 Connector 명령을 실행 중입니다."));
        return;
    }
    executeCommand(pending.envelope, pending.generation);
}

void ConnectorBackend::executeCommand(const QJsonObject &envelope, quint64 generation)
{
    if (m_actionBusy) {
        sendAck(envelope, false, QStringLiteral("다른 Connector 명령을 실행 중입니다."));
        return;
    }
    if (!deadlineAllowsExecution(envelope)) {
        sendAck(envelope, false,
                QStringLiteral("명령 기한이 만료되었거나 안전한 실행 예산이 부족합니다."));
        addActivity(QStringLiteral("command"), QStringLiteral("Command expired"),
                    envelope.value(QStringLiteral("action")).toString(), false);
        return;
    }
    const QString commandId = envelope.value(QStringLiteral("commandId")).toString();
    rememberCommandId(commandId);
    m_activeCommandId = commandId;
    sendAck(envelope, true);
    m_actionBusy = true;
    setPhase(QStringLiteral("busy"));
    const QDateTime startedAt = QDateTime::currentDateTimeUtc();
    const QString action = envelope.value(QStringLiteral("action")).toString();
    const QJsonObject params = envelope.value(QStringLiteral("params")).toObject();
    const quint64 sessionGeneration = m_sessionGeneration;
    const auto cancellation = std::make_shared<ExecutionCancellation>();
    m_activeCancellation = cancellation;
    auto *watcher = new QFutureWatcher<QJsonObject>(this);
    connect(watcher, &QFutureWatcher<QJsonObject>::finished, this,
            [this, watcher, envelope, generation, sessionGeneration, cancellation, startedAt, action] {
        const QJsonObject result = watcher->result();
        watcher->deleteLater();
        if (m_activeCancellation == cancellation) {
            m_activeCancellation.reset();
            m_activeCommandId.clear();
        }
        m_actionBusy = false;
        if (generation != m_executionGeneration
            || sessionGeneration != m_sessionGeneration
            || m_webSocket.state() != QAbstractSocket::ConnectedState) {
            addActivity(QStringLiteral("safety"), QStringLiteral("In-flight result discarded"), action, false);
            emit stateChanged();
            return;
        }
        QJsonObject message{
            {QStringLiteral("type"), QStringLiteral("command.result")},
            {QStringLiteral("commandId"), envelope.value(QStringLiteral("commandId"))},
            {QStringLiteral("sequence"), envelope.value(QStringLiteral("sequence"))},
            {QStringLiteral("status"), result.value(QStringLiteral("status"))},
            {QStringLiteral("stdout"), result.value(QStringLiteral("stdout"))},
            {QStringLiteral("stderr"), result.value(QStringLiteral("stderr"))},
            {QStringLiteral("exitCode"), result.value(QStringLiteral("exitCode"))},
            {QStringLiteral("startedAt"), startedAt.toString(Qt::ISODateWithMs)},
            {QStringLiteral("completedAt"), timestamp()},
        };
        if (result.contains(QStringLiteral("artifact"))) message.insert(QStringLiteral("artifact"), result.value(QStringLiteral("artifact")));
        sendJson(message);
        setPhase(QStringLiteral("online"));
        const bool succeeded = result.value(QStringLiteral("status")).toString() == QLatin1String("completed");
        addActivity(QStringLiteral("command"), succeeded ? QStringLiteral("Command completed") : QStringLiteral("Command failed"), action, succeeded);
    });
    watcher->setFuture(QtConcurrent::run([action, params, cancellation] {
        return PlatformAdapter::execute(action, params, cancellation);
    }));
}

void ConnectorBackend::sendAck(const QJsonObject &envelope, bool accepted, const QString &reason)
{
    QJsonObject message{
        {QStringLiteral("type"), QStringLiteral("command.ack")},
        {QStringLiteral("commandId"), envelope.value(QStringLiteral("commandId"))},
        {QStringLiteral("sequence"), envelope.value(QStringLiteral("sequence"))},
        {QStringLiteral("accepted"), accepted},
        {QStringLiteral("acknowledgedAt"), timestamp()},
    };
    if (!reason.isEmpty()) message.insert(QStringLiteral("reason"), reason);
    sendJson(message);
}

void ConnectorBackend::rejectAllPending(const QString &reason)
{
    const QStringList ids = m_pending.keys();
    for (const QString &id : ids) resolveCommand(id, false, reason);
}

void ConnectorBackend::cancelPairing()
{
    ++m_pairingGeneration;
    if (!m_pairingReply) return;
    QPointer<QNetworkReply> reply = m_pairingReply;
    m_pairingReply.clear();
    m_actionBusy = false;
    reply->abort();
}

void ConnectorBackend::cancelActiveExecution()
{
    if (m_activeCancellation) m_activeCancellation->cancel();
}

void ConnectorBackend::emergencyStop()
{
    cancelPairing();
    ++m_executionGeneration;
    cancelActiveExecution();
    rejectAllPending(QStringLiteral("로컬 긴급 중단으로 취소되었습니다."));
    disconnectConnector();
    addActivity(QStringLiteral("safety"), QStringLiteral("Emergency stop"),
                QStringLiteral("대기 중인 명령과 세션을 중단하고 실행 중인 결과를 폐기했습니다."), true);
}
