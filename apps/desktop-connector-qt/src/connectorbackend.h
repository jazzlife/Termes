#pragma once

#include <QHash>
#include <QJsonObject>
#include <QList>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QObject>
#include <QPointer>
#include <QSet>
#include <QTimer>
#include <QVariantList>
#include <QVariantMap>
#include <QWebSocket>

#include <memory>

class ExecutionCancellation;

class ConnectorBackend final : public QObject
{
    Q_OBJECT
    Q_PROPERTY(QString phase READ phase NOTIFY stateChanged)
    Q_PROPERTY(bool paired READ paired NOTIFY stateChanged)
    Q_PROPERTY(QVariantMap settings READ settings NOTIFY stateChanged)
    Q_PROPERTY(QVariantMap permissions READ permissions NOTIFY stateChanged)
    Q_PROPERTY(QVariantList pendingApprovals READ pendingApprovals NOTIFY stateChanged)
    Q_PROPERTY(QVariantList activities READ activities NOTIFY stateChanged)
    Q_PROPERTY(QString lastError READ lastError NOTIFY stateChanged)
    Q_PROPERTY(QString defaultDeviceName READ defaultDeviceName CONSTANT)
    Q_PROPERTY(bool actionBusy READ actionBusy NOTIFY stateChanged)

public:
    explicit ConnectorBackend(QObject *parent = nullptr);

    QString phase() const { return m_phase; }
    bool paired() const { return !m_settings.isEmpty(); }
    QVariantMap settings() const { return m_settings; }
    QVariantMap permissions() const { return m_permissions; }
    QVariantList pendingApprovals() const { return m_pendingApprovals; }
    QVariantList activities() const { return m_activities; }
    QString lastError() const { return m_lastError; }
    QString defaultDeviceName() const;
    bool actionBusy() const { return m_actionBusy; }

    Q_INVOKABLE void pairConnector(const QString &apiBaseUrl,
                                   const QString &pairingCode,
                                   const QString &deviceName);
    Q_INVOKABLE void connectConnector();
    Q_INVOKABLE void disconnectConnector();
    Q_INVOKABLE void forgetConnector();
    Q_INVOKABLE void setAutoObserve(bool enabled);
    Q_INVOKABLE void refreshPermissions();
    Q_INVOKABLE void requestPermission(const QString &kind);
    Q_INVOKABLE void openPermissionSettings(const QString &kind);
    Q_INVOKABLE void approveCommand(const QString &commandId);
    Q_INVOKABLE void rejectCommand(const QString &commandId);
    Q_INVOKABLE void emergencyStop();
    Q_INVOKABLE void clearError();

    static QString normalizeApiBaseUrl(const QString &value, QString *error = nullptr);
    static QByteArray commandRequestHash(const QJsonObject &envelope);
    static QByteArray commandRequestHashFromWire(const QByteArray &message);

signals:
    void stateChanged();

private:
    friend class ConnectorBackendTest;

    static constexpr qsizetype MaxPendingCommands = 64;
    static constexpr qsizetype MaxSeenCommandIds = 1024;

    enum class SocketConnectAction { Ignore, Open, WaitForDisconnected };

    struct PendingCommand {
        QJsonObject envelope;
        QPointer<QTimer> timer;
        QString requestedAt;
        quint64 generation = 0;
    };

    void loadSettings();
    bool saveSettings(QString *error = nullptr) const;
    bool removeSettings(QString *error = nullptr) const;
    QString settingsPath() const;
    QString machineFingerprint() const;
    QUrl websocketUrl(QString *error = nullptr) const;
    void setPhase(const QString &phase, const QString &error = {});
    void addActivity(const QString &kind,
                     const QString &title,
                     const QString &detail,
                     const QVariant &success = {});
    void scheduleReconnect();
    static SocketConnectAction socketConnectAction(
        QAbstractSocket::SocketState state, bool socketCycleActive);
    void handleWebSocketDisconnected();
    void sendJson(const QJsonObject &message);
    void sendHello();
    void sendHeartbeat();
    void handleWebSocketMessage(const QString &message);
    void handleCommand(const QJsonObject &envelope, const QByteArray &wireRequestHash);
    void rememberCommandId(const QString &commandId);
    void resolveCommand(const QString &commandId, bool approved, const QString &reason = {});
    void executeCommand(const QJsonObject &envelope, quint64 generation);
    void sendAck(const QJsonObject &envelope, bool accepted, const QString &reason = {});
    void rejectAllPending(const QString &reason);
    void rebuildPendingApprovals();
    void cancelPairing();
    void cancelActiveExecution();
    QString token(QString *error = nullptr) const;

    QNetworkAccessManager m_network;
    QWebSocket m_webSocket;
    QTimer m_heartbeatTimer;
    QTimer m_reconnectTimer;
    QTimer m_connectTimeout;
    QVariantMap m_settings;
    QVariantMap m_permissions;
    QVariantList m_pendingApprovals;
    QVariantList m_activities;
    QHash<QString, PendingCommand> m_pending;
    QSet<QString> m_seenCommandIds;
    QList<QString> m_seenCommandOrder;
    QPointer<QNetworkReply> m_pairingReply;
    std::shared_ptr<ExecutionCancellation> m_activeCancellation;
    QString m_activeCommandId;
    QString m_phase = QStringLiteral("unpaired");
    QString m_lastError;
    bool m_manualDisconnect = false;
    bool m_connectAfterDisconnect = false;
    bool m_socketCycleActive = false;
    bool m_actionBusy = false;
    int m_reconnectBackoffSeconds = 2;
    quint64 m_executionGeneration = 0;
    quint64 m_pairingGeneration = 0;
    quint64 m_sessionGeneration = 0;
    qint64 m_lastCommandSequence = 0;
};
