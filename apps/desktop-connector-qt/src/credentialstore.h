#pragma once

#include <QString>

class CredentialStore
{
public:
    static bool save(const QString &account, const QString &secret, QString *error = nullptr);
    static QString load(const QString &account, QString *error = nullptr);
    static bool remove(const QString &account, QString *error = nullptr);
    static constexpr const char *Service = "app.turtlelab.termes.connector";
};
