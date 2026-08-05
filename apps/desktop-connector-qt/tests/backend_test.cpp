#include <QJsonObject>
#include <QFile>
#include <QJsonDocument>
#include <QTemporaryDir>
#include <QUuid>
#include <QtTest>

#include "connectorbackend.h"
#include "platformadapter.h"

class StubNetworkReply final : public QNetworkReply
{
public:
    explicit StubNetworkReply(QObject *parent = nullptr) : QNetworkReply(parent)
    {
        open(QIODevice::ReadOnly);
    }

    void abort() override { aborted = true; }
    qint64 readData(char *, qint64) override { return -1; }

    bool aborted = false;
};

class ConnectorBackendTest final : public QObject
{
    Q_OBJECT

private slots:
    void rejectsPersistedRemotePlainHttp()
    {
        QTemporaryDir directory;
        QVERIFY(directory.isValid());
        qputenv("TERMES_CONNECTOR_QT_DATA_DIR", directory.path().toUtf8());
        QFile file(directory.filePath(QStringLiteral("connector.json")));
        QVERIFY(file.open(QIODevice::WriteOnly));
        file.write(QJsonDocument(QJsonObject{
            {QStringLiteral("apiBaseUrl"), QStringLiteral("http://termes.example")},
            {QStringLiteral("connectorId"), QStringLiteral("connector-1")},
        }).toJson());
        file.close();

        ConnectorBackend backend;
        QVERIFY(!backend.paired());
        QCOMPARE(backend.phase(), QStringLiteral("error"));
        QVERIFY(!backend.lastError().isEmpty());
    }

    void rejectsPersistedApiBaseUrlUserInfo()
    {
        QTemporaryDir directory;
        QVERIFY(directory.isValid());
        qputenv("TERMES_CONNECTOR_QT_DATA_DIR", directory.path().toUtf8());
        QFile file(directory.filePath(QStringLiteral("connector.json")));
        QVERIFY(file.open(QIODevice::WriteOnly));
        file.write(QJsonDocument(QJsonObject{
            {QStringLiteral("apiBaseUrl"), QStringLiteral("https://operator:secret@termes.example")},
            {QStringLiteral("connectorId"), QStringLiteral("connector-1")},
        }).toJson());
        file.close();

        ConnectorBackend backend;
        QVERIFY(!backend.paired());
        QCOMPARE(backend.phase(), QStringLiteral("error"));
        QVERIFY(!backend.lastError().isEmpty());
    }

    void websocketUrlRevalidatesStoredApiBaseUrl()
    {
        QTemporaryDir directory;
        QVERIFY(directory.isValid());
        qputenv("TERMES_CONNECTOR_QT_DATA_DIR", directory.path().toUtf8());
        ConnectorBackend backend;
        backend.m_settings = {
            {QStringLiteral("apiBaseUrl"), QStringLiteral("http://termes.example")},
            {QStringLiteral("connectorId"), QStringLiteral("connector-1")},
        };

        QString error;
        QVERIFY(!backend.websocketUrl(&error).isValid());
        QVERIFY(!error.isEmpty());
    }

    void normalizesSecureApiBaseUrl()
    {
        QString error;
        QCOMPARE(ConnectorBackend::normalizeApiBaseUrl(
                     QStringLiteral("https://termes.example/api/path?ignored=1"), &error),
                 QStringLiteral("https://termes.example"));
        QVERIFY(error.isEmpty());
    }

    void rejectsRemotePlainHttp()
    {
        QString error;
        QVERIFY(ConnectorBackend::normalizeApiBaseUrl(
                    QStringLiteral("http://termes.example"), &error).isEmpty());
        QVERIFY(!error.isEmpty());
    }

    void acceptsLoopbackPlainHttp()
    {
        QString error;
        QCOMPARE(ConnectorBackend::normalizeApiBaseUrl(
                     QStringLiteral("http://127.0.0.1:3000/path"), &error),
                 QStringLiteral("http://127.0.0.1:3000"));
        QVERIFY(error.isEmpty());
    }

    void rejectsApiBaseUrlUserInfo()
    {
        QString error;
        QVERIFY(ConnectorBackend::normalizeApiBaseUrl(
                    QStringLiteral("https://operator:secret@termes.example"), &error).isEmpty());
        QVERIFY(!error.isEmpty());

        QVERIFY(ConnectorBackend::normalizeApiBaseUrl(
                    QStringLiteral("https://operator@termes.example"), &error).isEmpty());
        QVERIFY(!error.isEmpty());
    }

    void matchesServerCommandHashOrder()
    {
        const QJsonObject envelope{
            {QStringLiteral("commandId"), QStringLiteral("123e4567-e89b-12d3-a456-426614174000")},
            {QStringLiteral("sequence"), 3},
            {QStringLiteral("action"), QStringLiteral("macos.system.info")},
            {QStringLiteral("params"), QJsonObject{{QStringLiteral("depth"), 2}}},
        };
        QCOMPARE(ConnectorBackend::commandRequestHash(envelope),
                 QByteArrayLiteral("1acc74803a506c1769df78acd95f5b7c472ef0181391165527281d066b9c5cd0"));
    }

    void preservesNestedParameterKeyOrderFromWireJson()
    {
        const QByteArray message = R"JSON({
            "commandId":"id",
            "sequence":7,
            "action":"macos.system.info",
            "params":{"z":1,"a":2}
        })JSON";
        QCOMPARE(ConnectorBackend::commandRequestHashFromWire(message),
                 QByteArrayLiteral("98fe490c1e996a7a075b0241b0e480e28d16a028d1755f9bb7b36d03518f25a4"));
    }

    void rejectsDuplicateTopLevelCommandKeys_data()
    {
        QTest::addColumn<QByteArray>("message");
        const QByteArray base = QByteArrayLiteral(
            "{\"type\":\"command\",\"protocolVersion\":1,"
            "\"commandId\":\"123e4567-e89b-42d3-a456-426614174000\","
            "\"sequence\":1,\"action\":\"macos.input.click\",\"params\":{},"
            "\"deadline\":\"2099-01-01T00:00:00.000Z\",\"requestHash\":\"hash\"}");
        const QList<QPair<QByteArray, QByteArray>> duplicates{
            {QByteArrayLiteral("\"type\":"), QByteArrayLiteral("\"type\":\"command\",")},
            {QByteArrayLiteral("\"protocolVersion\":"), QByteArrayLiteral("\"protocolVersion\":1,")},
            {QByteArrayLiteral("\"commandId\":"), QByteArrayLiteral("\"commandId\":\"123e4567-e89b-42d3-a456-426614174001\",")},
            {QByteArrayLiteral("\"sequence\":"), QByteArrayLiteral("\"sequence\":2,")},
            {QByteArrayLiteral("\"action\":"), QByteArrayLiteral("\"action\":\"macos.system.info\",")},
            {QByteArrayLiteral("\"params\":"), QByteArrayLiteral("\"params\":{\"x\":1},")},
            {QByteArrayLiteral("\"deadline\":"), QByteArrayLiteral("\"deadline\":\"2099-01-02T00:00:00.000Z\",")},
            {QByteArrayLiteral("\"requestHash\":"), QByteArrayLiteral("\"requestHash\":\"other\",")},
        };
        for (qsizetype index = 0; index < duplicates.size(); ++index) {
            QByteArray message = base;
            const qsizetype position = message.indexOf(duplicates[index].first);
            QVERIFY(position >= 0);
            message.insert(position, duplicates[index].second);
            QTest::newRow(qPrintable(QStringLiteral("duplicate-%1").arg(index))) << message;
        }
    }

    void rejectsDuplicateTopLevelCommandKeys()
    {
        QFETCH(QByteArray, message);
        QVERIFY(ConnectorBackend::commandRequestHashFromWire(message).isEmpty());

        QTemporaryDir directory;
        QVERIFY(directory.isValid());
        qputenv("TERMES_CONNECTOR_QT_DATA_DIR", directory.path().toUtf8());
        ConnectorBackend backend;
        backend.handleWebSocketMessage(QString::fromUtf8(message));
        QVERIFY(backend.m_pending.isEmpty());
        QCOMPARE(backend.phase(), QStringLiteral("error"));
    }

    void exposesOnlyTypedPlatformCapabilities()
    {
        const QString prefix = PlatformAdapter::actionPrefix() + QLatin1Char('.');
        const QStringList capabilities = PlatformAdapter::capabilities();
        QCOMPARE(capabilities.size(), 10);
        for (const QString &capability : capabilities) {
            QVERIFY(capability.startsWith(prefix));
            QVERIFY(!capability.contains(QStringLiteral("shell")));
            QVERIFY(!capability.contains(QStringLiteral("powershell")));
        }
        QVERIFY(PlatformAdapter::isReadOnly(prefix + QStringLiteral("system.info")));
        QVERIFY(!PlatformAdapter::isReadOnly(prefix + QStringLiteral("screen.capture")));
    }

    void preservesWhitespaceOnlyInputText()
    {
        QString error;
        QCOMPARE(PlatformAdapter::inputText(
                     QJsonObject{{QStringLiteral("text"), QStringLiteral("  \t  ")}}, &error),
                 QStringLiteral("  \t  "));
        QVERIFY(error.isEmpty());
        QCOMPARE(PlatformAdapter::inputText(
                     QJsonObject{{QStringLiteral("text"), QStringLiteral("  literal text  ")}}, &error),
                 QStringLiteral("  literal text  "));
        QVERIFY(error.isEmpty());
    }

    void preCancelledExecutionDoesNotStartWork()
    {
        const auto cancellation = std::make_shared<ExecutionCancellation>();
        cancellation->cancel();
        const QJsonObject result = PlatformAdapter::execute(
            PlatformAdapter::actionPrefix() + QStringLiteral(".system.info"), {}, cancellation);
        QCOMPARE(result.value(QStringLiteral("status")).toString(), QStringLiteral("cancelled"));
    }

    void forgetAndEmergencyStopAbortPairingReply()
    {
        QTemporaryDir directory;
        QVERIFY(directory.isValid());
        qputenv("TERMES_CONNECTOR_QT_DATA_DIR", directory.path().toUtf8());
        ConnectorBackend backend;

        auto *forgottenReply = new StubNetworkReply(&backend);
        backend.m_pairingReply = forgottenReply;
        const quint64 forgetGeneration = backend.m_pairingGeneration;
        backend.forgetConnector();
        QVERIFY(forgottenReply->aborted);
        QVERIFY(!backend.m_pairingReply);
        QVERIFY(backend.m_pairingGeneration > forgetGeneration);

        auto *stoppedReply = new StubNetworkReply(&backend);
        backend.m_pairingReply = stoppedReply;
        const quint64 stopGeneration = backend.m_pairingGeneration;
        backend.emergencyStop();
        QVERIFY(stoppedReply->aborted);
        QVERIFY(!backend.m_pairingReply);
        QVERIFY(backend.m_pairingGeneration > stopGeneration);
    }

    void disconnectCancelsActiveExecutionToken()
    {
        QTemporaryDir directory;
        QVERIFY(directory.isValid());
        qputenv("TERMES_CONNECTOR_QT_DATA_DIR", directory.path().toUtf8());
        ConnectorBackend backend;
        const auto cancellation = std::make_shared<ExecutionCancellation>();
        backend.m_activeCancellation = cancellation;
        const quint64 executionGeneration = backend.m_executionGeneration;
        const quint64 sessionGeneration = backend.m_sessionGeneration;

        backend.disconnectConnector();
        QVERIFY(cancellation->isCancelled());
        QVERIFY(backend.m_executionGeneration > executionGeneration);
        QVERIFY(backend.m_sessionGeneration > sessionGeneration);
        QCOMPARE(backend.phase(), QStringLiteral("unpaired"));
    }

    void serializesConnectWhileWebSocketIsClosing()
    {
        QCOMPARE(ConnectorBackend::socketConnectAction(QAbstractSocket::ClosingState, true),
                 ConnectorBackend::SocketConnectAction::WaitForDisconnected);
        QCOMPARE(ConnectorBackend::socketConnectAction(QAbstractSocket::UnconnectedState, false),
                 ConnectorBackend::SocketConnectAction::Open);
        QCOMPARE(ConnectorBackend::socketConnectAction(QAbstractSocket::UnconnectedState, true),
                 ConnectorBackend::SocketConnectAction::WaitForDisconnected);
        QCOMPARE(ConnectorBackend::socketConnectAction(QAbstractSocket::ConnectedState, true),
                 ConnectorBackend::SocketConnectAction::Ignore);
    }

    void deferredConnectDoesNotTreatPreviousDisconnectAsConnectionLoss()
    {
        QTemporaryDir directory;
        QVERIFY(directory.isValid());
        qputenv("TERMES_CONNECTOR_QT_DATA_DIR", directory.path().toUtf8());
        ConnectorBackend backend;
        backend.m_settings = {
            {QStringLiteral("apiBaseUrl"), QStringLiteral("http://127.0.0.1:3000")},
            {QStringLiteral("connectorId"), QStringLiteral("123e4567-e89b-42d3-a456-426614174000")},
        };
        backend.m_phase = QStringLiteral("connecting");
        backend.m_manualDisconnect = true;
        backend.m_connectAfterDisconnect = true;

        backend.handleWebSocketDisconnected();

        QVERIFY(!backend.m_connectAfterDisconnect);
        QCOMPARE(backend.phase(), QStringLiteral("offline"));
        QVERIFY(!backend.m_reconnectTimer.isActive());
        QVERIFY(backend.lastError().isEmpty());
    }

    void rejectsNonPositiveAndNonMonotonicSequences()
    {
        QTemporaryDir directory;
        QVERIFY(directory.isValid());
        qputenv("TERMES_CONNECTOR_QT_DATA_DIR", directory.path().toUtf8());
        ConnectorBackend backend;

        const QJsonObject zero = validCommand(QStringLiteral("zero"), 0);
        backend.handleCommand(zero, ConnectorBackend::commandRequestHash(zero));
        QVERIFY(backend.m_pending.isEmpty());

        const QJsonObject newer = validCommand(QStringLiteral("newer"), 2);
        backend.handleCommand(newer, ConnectorBackend::commandRequestHash(newer));
        QCOMPARE(backend.m_pending.size(), 1);

        const QJsonObject older = validCommand(QStringLiteral("older"), 1);
        backend.handleCommand(older, ConnectorBackend::commandRequestHash(older));
        QCOMPARE(backend.m_pending.size(), 1);
        QVERIFY(!backend.m_pending.contains(commandIdFor(QStringLiteral("older"))));
    }

    void rejectsMalformedCommandIds()
    {
        QTemporaryDir directory;
        QVERIFY(directory.isValid());
        qputenv("TERMES_CONNECTOR_QT_DATA_DIR", directory.path().toUtf8());
        ConnectorBackend backend;

        QJsonObject malformed = validCommand(QStringLiteral("malformed"), 1);
        malformed.insert(QStringLiteral("commandId"), QStringLiteral("not-a-uuid"));
        malformed.insert(QStringLiteral("requestHash"),
                         QString::fromLatin1(ConnectorBackend::commandRequestHash(malformed)));
        backend.handleCommand(malformed, ConnectorBackend::commandRequestHash(malformed));
        QVERIFY(backend.m_pending.isEmpty());
        QVERIFY(backend.m_seenCommandIds.isEmpty());

        QJsonObject oversized = validCommand(QStringLiteral("oversized-id"), 2);
        oversized.insert(QStringLiteral("commandId"), QString(1024, QLatin1Char('a')));
        oversized.insert(QStringLiteral("requestHash"),
                         QString::fromLatin1(ConnectorBackend::commandRequestHash(oversized)));
        backend.handleCommand(oversized, ConnectorBackend::commandRequestHash(oversized));
        QVERIFY(backend.m_pending.isEmpty());
        QVERIFY(backend.m_seenCommandIds.isEmpty());
    }

    void pendingCapacityRejectionsConsumeSequenceWithoutFillingSeenCache()
    {
        QTemporaryDir directory;
        QVERIFY(directory.isValid());
        qputenv("TERMES_CONNECTOR_QT_DATA_DIR", directory.path().toUtf8());
        ConnectorBackend backend;

        for (qsizetype index = 0; index < ConnectorBackend::MaxPendingCommands; ++index) {
            const QJsonObject command = validCommand(QString::number(index), index + 1);
            backend.handleCommand(command, ConnectorBackend::commandRequestHash(command));
        }
        for (qsizetype index = ConnectorBackend::MaxPendingCommands;
             index < ConnectorBackend::MaxSeenCommandIds + 32; ++index) {
            const QJsonObject command = validCommand(QString::number(index), index + 1);
            backend.handleCommand(command, ConnectorBackend::commandRequestHash(command));
        }

        QCOMPARE(backend.m_pending.size(), ConnectorBackend::MaxPendingCommands);
        QCOMPARE(backend.m_pendingApprovals.size(), ConnectorBackend::MaxPendingCommands);
        QCOMPARE(backend.m_seenCommandIds.size(), ConnectorBackend::MaxPendingCommands);
        QCOMPARE(backend.m_seenCommandOrder.size(), ConnectorBackend::MaxPendingCommands);
        QCOMPARE(backend.m_lastCommandSequence, qint64(ConnectorBackend::MaxSeenCommandIds + 32));

        const QString rejectedSeed = QString::number(ConnectorBackend::MaxPendingCommands);
        QVERIFY(!backend.m_seenCommandIds.contains(commandIdFor(rejectedSeed)));
        const QJsonObject replay = validCommand(rejectedSeed, ConnectorBackend::MaxPendingCommands + 1);
        backend.handleCommand(replay, ConnectorBackend::commandRequestHash(replay));
        QCOMPARE(backend.m_pending.size(), ConnectorBackend::MaxPendingCommands);

        backend.rejectCommand(commandIdFor(QStringLiteral("0")));
        const qint64 nextSequence = ConnectorBackend::MaxSeenCommandIds + 33;
        const QJsonObject next = validCommand(QStringLiteral("after-capacity"), nextSequence);
        backend.handleCommand(next, ConnectorBackend::commandRequestHash(next));
        QVERIFY(backend.m_pending.contains(commandIdFor(QStringLiteral("after-capacity"))));
        QCOMPARE(backend.m_seenCommandIds.size(), ConnectorBackend::MaxPendingCommands + 1);
        QCOMPARE(backend.m_seenCommandOrder.size(), ConnectorBackend::MaxPendingCommands + 1);
    }

    void evictsOldSeenCommandIdsWithoutExhaustingSession()
    {
        QTemporaryDir directory;
        QVERIFY(directory.isValid());
        qputenv("TERMES_CONNECTOR_QT_DATA_DIR", directory.path().toUtf8());
        ConnectorBackend backend;

        for (qsizetype index = 0; index < ConnectorBackend::MaxSeenCommandIds + 32; ++index) {
            const QString seed = QString::number(index);
            const QJsonObject command = validCommand(seed, index + 1);
            const QString commandId = commandIdFor(seed);
            backend.handleCommand(command, ConnectorBackend::commandRequestHash(command));
            QVERIFY(backend.m_pending.contains(commandId));
            backend.rejectCommand(commandId);
        }

        QCOMPARE(backend.m_seenCommandIds.size(), ConnectorBackend::MaxSeenCommandIds);
        QVERIFY(!backend.m_seenCommandIds.contains(commandIdFor(QStringLiteral("0"))));

        const qint64 nextSequence = ConnectorBackend::MaxSeenCommandIds + 33;
        const QJsonObject next = validCommand(QStringLiteral("after-limit"), nextSequence);
        const QString nextId = commandIdFor(QStringLiteral("after-limit"));
        backend.handleCommand(next, ConnectorBackend::commandRequestHash(next));
        QVERIFY(backend.m_pending.contains(nextId));

        const QJsonObject replay = validCommand(QStringLiteral("0"), 1);
        backend.handleCommand(replay, ConnectorBackend::commandRequestHash(replay));
        QCOMPARE(backend.m_pending.size(), 1);
        QVERIFY(backend.m_pending.contains(nextId));
    }

    void exposesActionSpecificExecutionBudgets()
    {
        const QString prefix = PlatformAdapter::actionPrefix() + QLatin1Char('.');
        QCOMPARE(PlatformAdapter::executionBudgetMs(prefix + QStringLiteral("logs.query")), qint64(57'000));
        QCOMPARE(PlatformAdapter::executionBudgetMs(prefix + QStringLiteral("input.click")), qint64(42'000));
        QCOMPARE(PlatformAdapter::executionBudgetMs(prefix + QStringLiteral("debug.process")), qint64(22'000));
    }

    void rejectsCommandWhenDeadlineCannotFitExecutionBudget()
    {
        QTemporaryDir directory;
        QVERIFY(directory.isValid());
        qputenv("TERMES_CONNECTOR_QT_DATA_DIR", directory.path().toUtf8());
        ConnectorBackend backend;
        QJsonObject command = validCommand(QStringLiteral("near-deadline"), 1);
        const QString action = command.value(QStringLiteral("action")).toString();
        command.insert(QStringLiteral("deadline"), QDateTime::currentDateTimeUtc()
            .addMSecs(PlatformAdapter::executionBudgetMs(action) - 1).toString(Qt::ISODateWithMs));
        command.insert(QStringLiteral("requestHash"),
                       QString::fromLatin1(ConnectorBackend::commandRequestHash(command)));

        backend.handleCommand(command, ConnectorBackend::commandRequestHash(command));
        QVERIFY(backend.m_pending.isEmpty());
        QVERIFY(backend.m_seenCommandIds.isEmpty());
        QVERIFY(!backend.m_actionBusy);
    }

    void approveCommandRechecksExpiredDeadline()
    {
        QTemporaryDir directory;
        QVERIFY(directory.isValid());
        qputenv("TERMES_CONNECTOR_QT_DATA_DIR", directory.path().toUtf8());
        ConnectorBackend backend;
        const QJsonObject command = validCommand(QStringLiteral("approval-expired"), 1);
        const QString commandId = command.value(QStringLiteral("commandId")).toString();
        backend.handleCommand(command, ConnectorBackend::commandRequestHash(command));
        QVERIFY(backend.m_pending.contains(commandId));

        backend.m_pending[commandId].envelope.insert(
            QStringLiteral("deadline"),
            QDateTime::currentDateTimeUtc().addMSecs(-1).toString(Qt::ISODateWithMs));
        backend.approveCommand(commandId);

        QVERIFY(backend.m_pending.isEmpty());
        QVERIFY(!backend.m_actionBusy);
        QVERIFY(!backend.m_activeCancellation);
    }

    void executeCommandRechecksNearDeadlineBeforeSideEffects()
    {
        QTemporaryDir directory;
        QVERIFY(directory.isValid());
        qputenv("TERMES_CONNECTOR_QT_DATA_DIR", directory.path().toUtf8());
        ConnectorBackend backend;
        QJsonObject command = validCommand(QStringLiteral("execution-expired"), 1);
        const QString action = command.value(QStringLiteral("action")).toString();
        command.insert(QStringLiteral("deadline"), QDateTime::currentDateTimeUtc()
            .addMSecs(PlatformAdapter::executionBudgetMs(action) - 1).toString(Qt::ISODateWithMs));

        backend.executeCommand(command, backend.m_executionGeneration);

        QVERIFY(!backend.m_actionBusy);
        QVERIFY(!backend.m_activeCancellation);
    }

    void pendingApprovalPreservesRequestedAtAcrossRebuilds()
    {
        QTemporaryDir directory;
        QVERIFY(directory.isValid());
        qputenv("TERMES_CONNECTOR_QT_DATA_DIR", directory.path().toUtf8());
        ConnectorBackend backend;
        const QJsonObject command = validCommand(QStringLiteral("requested-at"), 1);
        const QString commandId = command.value(QStringLiteral("commandId")).toString();
        backend.handleCommand(command, ConnectorBackend::commandRequestHash(command));
        QVERIFY(backend.m_pending.contains(commandId));
        const QString requestedAt = backend.m_pending.value(commandId).requestedAt;
        QVERIFY(!requestedAt.isEmpty());

        QTest::qWait(5);
        backend.rebuildPendingApprovals();
        QCOMPARE(backend.m_pendingApprovals.first().toMap().value(QStringLiteral("requestedAt")).toString(),
                 requestedAt);
    }

    void duplicatePendingCommandIdIsRejectedAfterSeenEviction()
    {
        QTemporaryDir directory;
        QVERIFY(directory.isValid());
        qputenv("TERMES_CONNECTOR_QT_DATA_DIR", directory.path().toUtf8());
        ConnectorBackend backend;

        const QJsonObject first = validCommand(QStringLiteral("duplicate"), 1);
        backend.handleCommand(first, ConnectorBackend::commandRequestHash(first));
        const QString commandId = commandIdFor(QStringLiteral("duplicate"));
        const QPointer<QTimer> originalTimer = backend.m_pending.value(commandId).timer;
        QVERIFY(originalTimer);

        for (qsizetype index = 0; index < ConnectorBackend::MaxSeenCommandIds; ++index) {
            const QString seed = QStringLiteral("evict-pending-%1").arg(index);
            const QJsonObject command = validCommand(seed, index + 2);
            const QString acceptedId = commandIdFor(seed);
            backend.handleCommand(command, ConnectorBackend::commandRequestHash(command));
            QVERIFY(backend.m_pending.contains(acceptedId));
            backend.rejectCommand(acceptedId);
        }
        QVERIFY(!backend.m_seenCommandIds.contains(commandId));
        QVERIFY(backend.m_pending.contains(commandId));

        const QJsonObject duplicate = validCommand(
            QStringLiteral("duplicate"), ConnectorBackend::MaxSeenCommandIds + 2);
        backend.handleCommand(duplicate, ConnectorBackend::commandRequestHash(duplicate));
        QCOMPARE(backend.m_pending.size(), 1);
        QCOMPARE(backend.m_pending.value(commandId).timer, originalTimer);
    }

    void duplicateActiveCommandIdIsRejectedOutsideSeenCache()
    {
        QTemporaryDir directory;
        QVERIFY(directory.isValid());
        qputenv("TERMES_CONNECTOR_QT_DATA_DIR", directory.path().toUtf8());
        ConnectorBackend backend;
        const QString commandId = commandIdFor(QStringLiteral("active-duplicate"));
        backend.m_activeCommandId = commandId;
        backend.m_lastCommandSequence = 1;

        const QJsonObject duplicate = validCommand(QStringLiteral("active-duplicate"), 2);
        backend.handleCommand(duplicate, ConnectorBackend::commandRequestHash(duplicate));

        QVERIFY(backend.m_pending.isEmpty());
        QVERIFY(backend.m_seenCommandIds.isEmpty());
        QCOMPARE(backend.m_activeCommandId, commandId);
        QCOMPARE(backend.m_lastCommandSequence, qint64(1));
    }

    void busyRejectionsConsumeSequenceWithoutFillingSeenCache()
    {
        QTemporaryDir directory;
        QVERIFY(directory.isValid());
        qputenv("TERMES_CONNECTOR_QT_DATA_DIR", directory.path().toUtf8());
        ConnectorBackend backend;
        backend.m_actionBusy = true;

        for (qsizetype index = 0; index < ConnectorBackend::MaxSeenCommandIds + 32; ++index) {
            const QJsonObject command = validCommand(QStringLiteral("busy-%1").arg(index), index + 1);
            backend.handleCommand(command, ConnectorBackend::commandRequestHash(command));
        }

        QVERIFY(backend.m_pending.isEmpty());
        QVERIFY(backend.m_seenCommandIds.isEmpty());
        QVERIFY(backend.m_seenCommandOrder.isEmpty());
        QCOMPARE(backend.m_lastCommandSequence, qint64(ConnectorBackend::MaxSeenCommandIds + 32));

        backend.m_actionBusy = false;
        const QJsonObject replay = validCommand(QStringLiteral("busy-0"), 1);
        backend.handleCommand(replay, ConnectorBackend::commandRequestHash(replay));
        QVERIFY(backend.m_pending.isEmpty());

        const qint64 nextSequence = ConnectorBackend::MaxSeenCommandIds + 33;
        const QJsonObject next = validCommand(QStringLiteral("after-busy"), nextSequence);
        backend.handleCommand(next, ConnectorBackend::commandRequestHash(next));
        QVERIFY(backend.m_pending.contains(commandIdFor(QStringLiteral("after-busy"))));
        QCOMPARE(backend.m_seenCommandIds.size(), 1);
        QCOMPARE(backend.m_seenCommandOrder.size(), 1);
    }

    void rejectsOversizedWebSocketMessageBeforeParsingCommand()
    {
        QTemporaryDir directory;
        QVERIFY(directory.isValid());
        qputenv("TERMES_CONNECTOR_QT_DATA_DIR", directory.path().toUtf8());
        ConnectorBackend backend;
        QJsonObject command = validCommand(QStringLiteral("oversized"), 1);
        command.insert(QStringLiteral("params"), QJsonObject{
            {QStringLiteral("x"), 1},
            {QStringLiteral("y"), 1},
            {QStringLiteral("padding"), QString(1024 * 1024, QLatin1Char('x'))},
        });
        command.insert(QStringLiteral("requestHash"),
                       QString::fromLatin1(ConnectorBackend::commandRequestHash(command)));

        backend.handleWebSocketMessage(QString::fromUtf8(
            QJsonDocument(command).toJson(QJsonDocument::Compact)));
        QVERIFY(backend.m_pending.isEmpty());
        QCOMPARE(backend.phase(), QStringLiteral("error"));
    }

private:
    static QString commandIdFor(const QString &seed)
    {
        return QUuid::createUuidV5(QUuid(), seed.toUtf8()).toString(QUuid::WithoutBraces);
    }

    static QJsonObject validCommand(const QString &commandId, qint64 sequence)
    {
        QJsonObject command{
            {QStringLiteral("type"), QStringLiteral("command")},
            {QStringLiteral("protocolVersion"), 1},
            {QStringLiteral("commandId"), commandIdFor(commandId)},
            {QStringLiteral("sequence"), sequence},
            {QStringLiteral("action"), PlatformAdapter::actionPrefix() + QStringLiteral(".input.click")},
            {QStringLiteral("params"), QJsonObject{{QStringLiteral("x"), 1}, {QStringLiteral("y"), 1}}},
            {QStringLiteral("deadline"), QDateTime::currentDateTimeUtc().addSecs(60).toString(Qt::ISODateWithMs)},
        };
        command.insert(QStringLiteral("requestHash"),
                       QString::fromLatin1(ConnectorBackend::commandRequestHash(command)));
        return command;
    }
};

QTEST_GUILESS_MAIN(ConnectorBackendTest)
#include "backend_test.moc"
