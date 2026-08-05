#pragma once

#include <QJsonObject>
#include <QStringList>
#include <QVariantMap>

#include <atomic>
#include <memory>

class ExecutionCancellation final
{
public:
    void cancel() noexcept { m_cancelled.store(true, std::memory_order_release); }
    bool isCancelled() const noexcept { return m_cancelled.load(std::memory_order_acquire); }

private:
    std::atomic_bool m_cancelled{false};
};

class PlatformAdapter
{
public:
    static QString platformName();
    static QString actionPrefix();
    static QStringList capabilities();
    static bool isReadOnly(const QString &action);
    static qint64 executionBudgetMs(const QString &action);
    static QVariantMap permissionState();
    static bool requestPermission(const QString &kind, QString *error = nullptr);
    static bool openPermissionSettings(const QString &kind, QString *error = nullptr);
    static QJsonObject execute(
        const QString &action,
        const QJsonObject &params,
        const std::shared_ptr<ExecutionCancellation> &cancellation = {});

private:
    friend class ConnectorBackendTest;
    static QString inputText(const QJsonObject &params, QString *error = nullptr);
};
