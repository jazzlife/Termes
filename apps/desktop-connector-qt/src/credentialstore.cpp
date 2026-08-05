#include "credentialstore.h"

#include <QByteArray>

#ifdef Q_OS_MACOS
#include <Security/Security.h>
#elif defined(Q_OS_WIN)
#include <windows.h>
#include <wincred.h>
#endif

namespace {
void setError(QString *target, const QString &message)
{
    if (target) {
        *target = message;
    }
}

#ifdef Q_OS_MACOS
QString osStatusMessage(OSStatus status)
{
    const auto text = SecCopyErrorMessageString(status, nullptr);
    if (!text) {
        return QStringLiteral("OSStatus %1").arg(status);
    }
    const QString value = QString::fromCFString(text);
    CFRelease(text);
    return value;
}

CFMutableDictionaryRef keychainQuery(const QString &account)
{
    const QByteArray serviceBytes(CredentialStore::Service);
    const QByteArray accountBytes = account.toUtf8();
    CFStringRef service = CFStringCreateWithBytes(
        nullptr, reinterpret_cast<const UInt8 *>(serviceBytes.constData()),
        serviceBytes.size(), kCFStringEncodingUTF8, false);
    CFStringRef accountValue = CFStringCreateWithBytes(
        nullptr, reinterpret_cast<const UInt8 *>(accountBytes.constData()),
        accountBytes.size(), kCFStringEncodingUTF8, false);
    CFMutableDictionaryRef query = CFDictionaryCreateMutable(
        nullptr, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword);
    CFDictionarySetValue(query, kSecAttrService, service);
    CFDictionarySetValue(query, kSecAttrAccount, accountValue);
    CFRelease(service);
    CFRelease(accountValue);
    return query;
}
#endif
}

bool CredentialStore::save(const QString &account, const QString &secret, QString *error)
{
#ifdef Q_OS_MACOS
    const QByteArray secretBytes = secret.toUtf8();
    CFMutableDictionaryRef query = keychainQuery(account);
    CFDataRef data = CFDataCreate(
        nullptr, reinterpret_cast<const UInt8 *>(secretBytes.constData()), secretBytes.size());
    OSStatus status = SecItemCopyMatching(query, nullptr);
    if (status == errSecSuccess) {
        const void *keys[] = {kSecValueData};
        const void *values[] = {data};
        CFDictionaryRef update = CFDictionaryCreate(
            nullptr, keys, values, 1, &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks);
        status = SecItemUpdate(query, update);
        CFRelease(update);
    } else if (status == errSecItemNotFound) {
        CFDictionarySetValue(query, kSecValueData, data);
        status = SecItemAdd(query, nullptr);
    }
    CFRelease(data);
    CFRelease(query);
    if (status != errSecSuccess) {
        setError(error, QStringLiteral("OS 보안 저장소에 Connector 자격 증명을 저장할 수 없습니다: %1")
                            .arg(osStatusMessage(status)));
        return false;
    }
    return true;
#elif defined(Q_OS_WIN)
    const QString target = QString::fromLatin1(Service) + QLatin1Char('/') + account;
    const QByteArray bytes = secret.toUtf8();
    CREDENTIALW credential{};
    credential.Type = CRED_TYPE_GENERIC;
    credential.TargetName = const_cast<wchar_t *>(reinterpret_cast<const wchar_t *>(target.utf16()));
    credential.CredentialBlobSize = DWORD(bytes.size());
    credential.CredentialBlob = reinterpret_cast<LPBYTE>(const_cast<char *>(bytes.constData()));
    credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
    credential.UserName = const_cast<wchar_t *>(reinterpret_cast<const wchar_t *>(account.utf16()));
    if (!CredWriteW(&credential, 0)) {
        setError(error, QStringLiteral("Windows Credential Manager 저장 실패: %1").arg(GetLastError()));
        return false;
    }
    return true;
#else
    Q_UNUSED(account)
    Q_UNUSED(secret)
    setError(error, QStringLiteral("이 플랫폼에는 보안 자격 증명 저장소가 구현되지 않았습니다."));
    return false;
#endif
}

QString CredentialStore::load(const QString &account, QString *error)
{
#ifdef Q_OS_MACOS
    CFMutableDictionaryRef query = keychainQuery(account);
    CFDictionarySetValue(query, kSecReturnData, kCFBooleanTrue);
    CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne);
    CFTypeRef result = nullptr;
    OSStatus status = SecItemCopyMatching(query, &result);
    CFRelease(query);
    if (status != errSecSuccess) {
        setError(error, QStringLiteral("OS 보안 저장소에서 Connector 자격 증명을 읽을 수 없습니다: %1")
                            .arg(osStatusMessage(status)));
        return {};
    }
    CFDataRef data = static_cast<CFDataRef>(result);
    const QString secret = QString::fromUtf8(
        reinterpret_cast<const char *>(CFDataGetBytePtr(data)), CFDataGetLength(data));
    CFRelease(data);
    return secret;
#elif defined(Q_OS_WIN)
    const QString target = QString::fromLatin1(Service) + QLatin1Char('/') + account;
    PCREDENTIALW credential = nullptr;
    if (!CredReadW(reinterpret_cast<const wchar_t *>(target.utf16()), CRED_TYPE_GENERIC, 0, &credential)) {
        setError(error, QStringLiteral("Windows Credential Manager 읽기 실패: %1").arg(GetLastError()));
        return {};
    }
    const QString secret = QString::fromUtf8(
        reinterpret_cast<const char *>(credential->CredentialBlob),
        qsizetype(credential->CredentialBlobSize));
    CredFree(credential);
    return secret;
#else
    Q_UNUSED(account)
    setError(error, QStringLiteral("이 플랫폼에는 보안 자격 증명 저장소가 구현되지 않았습니다."));
    return {};
#endif
}

bool CredentialStore::remove(const QString &account, QString *error)
{
#ifdef Q_OS_MACOS
    CFMutableDictionaryRef query = keychainQuery(account);
    OSStatus status = SecItemDelete(query);
    CFRelease(query);
    if (status == errSecItemNotFound) {
        return true;
    }

    if (status != errSecSuccess) {
        setError(error, QStringLiteral("Connector 자격 증명을 제거할 수 없습니다: %1")
                            .arg(osStatusMessage(status)));
        return false;
    }
    return true;
#elif defined(Q_OS_WIN)
    const QString target = QString::fromLatin1(Service) + QLatin1Char('/') + account;
    if (!CredDeleteW(reinterpret_cast<const wchar_t *>(target.utf16()), CRED_TYPE_GENERIC, 0)
        && GetLastError() != ERROR_NOT_FOUND) {
        setError(error, QStringLiteral("Windows Credential Manager 삭제 실패: %1").arg(GetLastError()));
        return false;
    }
    return true;
#else
    Q_UNUSED(account)
    setError(error, QStringLiteral("이 플랫폼에는 보안 자격 증명 저장소가 구현되지 않았습니다."));
    return false;
#endif
}
