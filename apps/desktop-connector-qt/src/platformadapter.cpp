#include "platformadapter.h"

#include <QCoreApplication>
#include <QCryptographicHash>
#include <QDateTime>
#include <QDesktopServices>
#include <QDir>
#include <QElapsedTimer>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QProcess>
#include <QProcessEnvironment>
#include <QRegularExpression>
#include <QStandardPaths>
#include <QStorageInfo>
#include <QSysInfo>
#include <QTemporaryFile>
#include <QThread>
#include <QUuid>
#include <QUrl>
#include <QVector>

#ifdef Q_OS_MACOS
#include <ApplicationServices/ApplicationServices.h>
#include <CoreGraphics/CoreGraphics.h>
#elif defined(Q_OS_WIN)
#include <windows.h>
#endif

namespace {
constexpr qsizetype MaxOutputBytes = 256 * 1024;
constexpr qint64 MaxCaptureBytes = 6 * 1024 * 1024;
constexpr int DefaultProcessTimeoutMs = 30'000;
constexpr int LogsQueryProcessTimeoutMs = 45'000;
thread_local std::shared_ptr<ExecutionCancellation> CurrentCancellation;

bool cancelled()
{
    return CurrentCancellation && CurrentCancellation->isCancelled();
}

class CancellationScope final
{
public:
    explicit CancellationScope(const std::shared_ptr<ExecutionCancellation> &cancellation)
        : m_previous(CurrentCancellation)
    {
        CurrentCancellation = cancellation;
    }
    ~CancellationScope() { CurrentCancellation = m_previous; }

private:
    std::shared_ptr<ExecutionCancellation> m_previous;
};

void appendBounded(QByteArray *target, const QByteArray &chunk)
{
    const qsizetype remaining = MaxOutputBytes - target->size();
    if (remaining > 0) target->append(chunk.constData(), qMin(remaining, chunk.size()));
}

void drainChannel(QProcess *process, QProcess::ProcessChannel channel, QByteArray *target)
{
    process->setReadChannel(channel);
    while (process->bytesAvailable() > 0) {
        const QByteArray chunk = process->read(qMin<qint64>(process->bytesAvailable(), 64 * 1024));
        if (chunk.isEmpty()) break;
        appendBounded(target, chunk);
    }
}

QJsonObject success(const QString &stdoutText = {})
{
    return {{QStringLiteral("status"), QStringLiteral("completed")},
            {QStringLiteral("stdout"), stdoutText},
            {QStringLiteral("stderr"), QString()},
            {QStringLiteral("exitCode"), 0}};
}

QJsonObject failure(const QString &message)
{
    return {{QStringLiteral("status"), QStringLiteral("failed")},
            {QStringLiteral("stdout"), QString()},
            {QStringLiteral("stderr"), message},
            {QStringLiteral("exitCode"), 1}};
}

QJsonObject cancelledResult()
{
    return {{QStringLiteral("status"), QStringLiteral("cancelled")},
            {QStringLiteral("stdout"), QString()},
            {QStringLiteral("stderr"), QStringLiteral("로컬에서 명령 실행을 취소했습니다.")},
            {QStringLiteral("exitCode"), -1}};
}

QJsonObject run(const QString &program,
                const QStringList &arguments,
                const QProcessEnvironment &environment = QProcessEnvironment::systemEnvironment(),
                int timeoutMs = DefaultProcessTimeoutMs)
{
    QProcess process;
    process.setProcessChannelMode(QProcess::SeparateChannels);
    process.setProcessEnvironment(environment);
    process.start(program, arguments);

    QElapsedTimer startedTimer;
    startedTimer.start();
    bool started = process.state() == QProcess::Running;
    while (!started && process.state() == QProcess::Starting
           && startedTimer.elapsed() < 5'000 && !cancelled()) {
        started = process.waitForStarted(50);
    }
    if (cancelled()) {
        process.kill();
        process.waitForFinished(2'000);
        return cancelledResult();
    }
    if (!started && process.state() == QProcess::NotRunning) {
        return failure(QStringLiteral("프로세스를 시작할 수 없습니다: %1").arg(process.errorString()));
    }

    QByteArray stdoutBytes;
    QByteArray stderrBytes;
    QElapsedTimer executionTimer;
    executionTimer.start();
    bool timedOut = false;
    while (process.state() != QProcess::NotRunning) {
        if (cancelled() || executionTimer.elapsed() >= timeoutMs) {
            timedOut = !cancelled();
            process.kill();
            process.waitForFinished(2'000);
            break;
        }
        const int remaining = qMax(1, timeoutMs - int(executionTimer.elapsed()));
        process.waitForFinished(qMin(50, remaining));
        drainChannel(&process, QProcess::StandardOutput, &stdoutBytes);
        drainChannel(&process, QProcess::StandardError, &stderrBytes);
    }
    drainChannel(&process, QProcess::StandardOutput, &stdoutBytes);
    drainChannel(&process, QProcess::StandardError, &stderrBytes);
    if (cancelled()) return cancelledResult();
    if (timedOut) return failure(QStringLiteral("명령 실행 시간이 제한을 초과했습니다."));

    const QString out = QString::fromUtf8(stdoutBytes);
    const QString err = QString::fromUtf8(stderrBytes);
    if (process.exitStatus() != QProcess::NormalExit || process.exitCode() != 0) {
        return {{QStringLiteral("status"), QStringLiteral("failed")},
                {QStringLiteral("stdout"), out},
                {QStringLiteral("stderr"), err.isEmpty() ? QStringLiteral("명령 실행 실패") : err},
                {QStringLiteral("exitCode"), process.exitCode()}};
    }
    return {{QStringLiteral("status"), QStringLiteral("completed")},
            {QStringLiteral("stdout"), out},
            {QStringLiteral("stderr"), err},
            {QStringLiteral("exitCode"), process.exitCode()}};
}

bool validIdentifier(const QString &value)
{
    static const QRegularExpression pattern(QStringLiteral("^[A-Za-z0-9._:\\\\/-]+$"));
    return pattern.match(value).hasMatch();
}

QString requiredString(const QJsonObject &params, const QString &key, qsizetype maximum, QString *error)
{
    const QString value = params.value(key).toString().trimmed();
    if (value.isEmpty()) {
        if (error) *error = QStringLiteral("필수 매개변수가 없습니다: %1").arg(key);
        return {};
    }
    if (value.size() > maximum) {
        if (error) *error = QStringLiteral("매개변수 %1이 최대 길이를 초과했습니다.").arg(key);
        return {};
    }
    return value;
}

QString inputTextValue(const QJsonObject &params, QString *error)
{
    if (error) error->clear();
    const QJsonValue value = params.value(QStringLiteral("text"));
    if (!value.isString() || value.toString().isEmpty()) {
        if (error) *error = QStringLiteral("필수 매개변수가 없습니다: text");
        return {};
    }
    const QString text = value.toString();
    if (text.size() > 4096) {
        if (error) *error = QStringLiteral("매개변수 text가 최대 길이를 초과했습니다.");
        return {};
    }
    return text;
}

qint64 requiredPid(const QJsonObject &params, QString *error)
{
    const qint64 pid = params.value(QStringLiteral("pid")).toInteger();
    if (pid <= 0 || pid == QCoreApplication::applicationPid()) {
        if (error) *error = QStringLiteral("Connector 자신 또는 유효하지 않은 프로세스는 대상으로 지정할 수 없습니다.");
        return -1;
    }
    return pid;
}

int boundedInt(const QJsonObject &params, const QString &key, int fallback, int minimum, int maximum)
{
    const int value = params.contains(key) ? params.value(key).toInt(fallback) : fallback;
    return qBound(minimum, value, maximum);
}

QJsonObject systemInfo()
{
    QJsonArray disks;
    for (const QStorageInfo &storage : QStorageInfo::mountedVolumes()) {
        if (!storage.isValid() || !storage.isReady()) continue;
        disks.append(QJsonObject{
            {QStringLiteral("name"), storage.name()},
            {QStringLiteral("mountPoint"), storage.rootPath()},
            {QStringLiteral("fileSystem"), QString::fromUtf8(storage.fileSystemType())},
            {QStringLiteral("totalBytes"), double(storage.bytesTotal())},
            {QStringLiteral("availableBytes"), double(storage.bytesAvailable())},
        });
    }
    QJsonObject payload{
        {QStringLiteral("platform"), PlatformAdapter::platformName()},
        {QStringLiteral("hostName"), QSysInfo::machineHostName()},
        {QStringLiteral("osName"), QSysInfo::prettyProductName()},
        {QStringLiteral("osVersion"), QSysInfo::productVersion()},
        {QStringLiteral("kernelVersion"), QSysInfo::kernelVersion()},
        {QStringLiteral("cpuArchitecture"), QSysInfo::currentCpuArchitecture()},
        {QStringLiteral("logicalCpuCount"), QThread::idealThreadCount()},
        {QStringLiteral("disks"), disks},
    };
#ifdef Q_OS_MACOS
    const auto memory = run(QStringLiteral("/usr/sbin/sysctl"), {QStringLiteral("-n"), QStringLiteral("hw.memsize")});
    payload.insert(QStringLiteral("totalMemoryBytes"), memory.value(QStringLiteral("stdout")).toString().trimmed().toDouble());
#elif defined(Q_OS_WIN)
    MEMORYSTATUSEX memory{};
    memory.dwLength = sizeof(memory);
    if (GlobalMemoryStatusEx(&memory)) {
        payload.insert(QStringLiteral("totalMemoryBytes"), double(memory.ullTotalPhys));
        payload.insert(QStringLiteral("availableMemoryBytes"), double(memory.ullAvailPhys));
    }
#endif
    return success(QString::fromUtf8(QJsonDocument(payload).toJson(QJsonDocument::Indented)));
}

QJsonObject processList()
{
#ifdef Q_OS_MACOS
    const QJsonObject raw = run(QStringLiteral("/bin/ps"),
                                {QStringLiteral("-axo"), QStringLiteral("pid=,ppid=,state=,comm=")});
    if (raw.value(QStringLiteral("status")).toString() != QLatin1String("completed")) return raw;
    QJsonArray processes;
    const QStringList lines = raw.value(QStringLiteral("stdout")).toString().split(QLatin1Char('\n'), Qt::SkipEmptyParts);
    static const QRegularExpression linePattern(QStringLiteral("^\\s*(\\d+)\\s+(\\d+)\\s+(\\S+)\\s+(.+)$"));
    for (const QString &line : lines) {
        const auto match = linePattern.match(line);
        if (!match.hasMatch()) continue;
        processes.append(QJsonObject{{QStringLiteral("pid"), match.captured(1).toLongLong()},
                                     {QStringLiteral("parentPid"), match.captured(2).toLongLong()},
                                     {QStringLiteral("status"), match.captured(3)},
                                     {QStringLiteral("name"), QFileInfo(match.captured(4)).fileName()},
                                     {QStringLiteral("executable"), match.captured(4)}});
        if (processes.size() >= 500) break;
    }
    return success(QString::fromUtf8(QJsonDocument(QJsonObject{{QStringLiteral("processes"), processes}}).toJson(QJsonDocument::Indented)));
#else
    const QString script = QStringLiteral("Get-CimInstance Win32_Process | Select-Object -First 500 ProcessId,ParentProcessId,Name,ExecutablePath,CreationDate | ConvertTo-Json -Depth 4 -Compress");
    return run(QStringLiteral("powershell.exe"), {QStringLiteral("-NoProfile"), QStringLiteral("-NonInteractive"), QStringLiteral("-Command"), script});
#endif
}

QJsonObject screenCapture()
{
    const QString path = QDir::temp().filePath(QStringLiteral("termes-qt-capture-%1.jpg").arg(QUuid::createUuid().toString(QUuid::WithoutBraces)));
#ifdef Q_OS_MACOS
    QJsonObject result = run(QStringLiteral("/usr/sbin/screencapture"),
                             {QStringLiteral("-x"), QStringLiteral("-t"), QStringLiteral("jpg"), path});
#else
    QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
    env.insert(QStringLiteral("TERMES_CAPTURE_PATH"), path);
    const QString script = QStringLiteral(
        "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; "
        "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen; $i=New-Object System.Drawing.Bitmap $b.Width,$b.Height; "
        "$g=[System.Drawing.Graphics]::FromImage($i); try{$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);$i.Save($env:TERMES_CAPTURE_PATH,[System.Drawing.Imaging.ImageFormat]::Jpeg)}finally{$g.Dispose();$i.Dispose()}");
    QJsonObject result = run(QStringLiteral("powershell.exe"),
                             {QStringLiteral("-NoProfile"), QStringLiteral("-NonInteractive"), QStringLiteral("-Command"), script}, env);
#endif
    if (result.value(QStringLiteral("status")).toString() != QLatin1String("completed")) {
        QFile::remove(path);
        return result;
    }
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) {
        QFile::remove(path);
        return failure(QStringLiteral("캡처 파일을 읽을 수 없습니다."));
    }
    const qint64 captureSize = file.size();
    if (captureSize <= 0 || captureSize > MaxCaptureBytes) {
        file.close();
        QFile::remove(path);
        return failure(QStringLiteral("캡처 결과가 비어 있거나 6 MiB 제한을 초과했습니다."));
    }
    const QByteArray bytes = file.read(MaxCaptureBytes + 1);
    file.close();
    QFile::remove(path);
    if (bytes.size() != captureSize || bytes.size() > MaxCaptureBytes) {
        return failure(QStringLiteral("캡처 결과가 비어 있거나 6 MiB 제한을 초과했습니다."));
    }
    result.insert(QStringLiteral("stdout"), QStringLiteral("Screen captured"));
    result.insert(QStringLiteral("artifact"), QJsonObject{
        {QStringLiteral("mimeType"), QStringLiteral("image/jpeg")},
        {QStringLiteral("base64"), QString::fromLatin1(bytes.toBase64())},
        {QStringLiteral("sha256"), QString::fromLatin1(QCryptographicHash::hash(bytes, QCryptographicHash::Sha256).toHex())},
        {QStringLiteral("metadata"), QJsonObject{
             {QStringLiteral("captureTimestamp"), QDateTime::currentDateTimeUtc().toString(Qt::ISODateWithMs)},
             {QStringLiteral("coordinateSpace"), QStringLiteral("virtual-desktop-physical-pixels")},
             {QStringLiteral("platform"), PlatformAdapter::platformName()},
         }},
    });
    return result;
}

QJsonObject accessibilitySnapshot(const QJsonObject &params)
{
    const int depth = boundedInt(params, QStringLiteral("depth"), 4, 1, 6);
    const int limit = boundedInt(params, QStringLiteral("limit"), 300, 1, 600);
    QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
    env.insert(QStringLiteral("TERMES_AX_DEPTH"), QString::number(depth));
    env.insert(QStringLiteral("TERMES_AX_LIMIT"), QString::number(limit));
#ifdef Q_OS_MACOS
    const QString script = QStringLiteral(R"JS(
ObjC.import('Foundation'); const se=Application('System Events'); const c=se.applicationProcesses.whose({frontmost:true})(); if(!c.length) throw new Error('No foreground application'); const app=c[0]; let count=0; function safe(fn,f){try{const v=fn();return v===undefined?f:v}catch(_){return f}} function node(el,d){if(count++>=Number($.getenv('TERMES_AX_LIMIT')))return null;const r={role:safe(()=>el.role(),''),subrole:safe(()=>el.subrole(),''),title:safe(()=>el.title(),''),description:safe(()=>el.description(),''),value:safe(()=>{const v=el.value();return ['string','number','boolean'].includes(typeof v)?v:null},null),enabled:safe(()=>el.enabled(),null),position:safe(()=>el.position(),null),size:safe(()=>el.size(),null),children:[]};if(d>0){for(const child of safe(()=>el.uiElements(),[])){const n=node(child,d-1);if(n)r.children.push(n);if(count>=Number($.getenv('TERMES_AX_LIMIT')))break}}return r} const roots=safe(()=>app.windows(),[]).slice(0,8).map(w=>node(w,Number($.getenv('TERMES_AX_DEPTH')))).filter(Boolean); JSON.stringify({application:safe(()=>app.name(),''),pid:safe(()=>app.unixId(),null),elementCount:count,windows:roots});
)JS");
    return run(QStringLiteral("/usr/bin/osascript"),
               {QStringLiteral("-l"), QStringLiteral("JavaScript"), QStringLiteral("-e"), script}, env);
#else
    const QString script = QStringLiteral(R"PS(
Add-Type -AssemblyName UIAutomationClient; $script:count=0; $limit=[int]$env:TERMES_AX_LIMIT; function Read-Node($e,[int]$d){if($null -eq $e -or $script:count -ge $limit){return $null};$script:count++;$n=[ordered]@{name=$e.Current.Name;automationId=$e.Current.AutomationId;controlType=$e.Current.ControlType.ProgrammaticName;className=$e.Current.ClassName;processId=$e.Current.ProcessId;enabled=$e.Current.IsEnabled;keyboardFocusable=$e.Current.IsKeyboardFocusable;children=@()};if($d -gt 0){foreach($c in $e.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)){$x=Read-Node $c ($d-1);if($null -ne $x){$n.children+=$x};if($script:count -ge $limit){break}}};return $n}; [ordered]@{elementCount=$script:count;root=(Read-Node ([System.Windows.Automation.AutomationElement]::FocusedElement) ([int]$env:TERMES_AX_DEPTH))}|ConvertTo-Json -Depth 12 -Compress
)PS");
    return run(QStringLiteral("powershell.exe"),
               {QStringLiteral("-NoProfile"), QStringLiteral("-NonInteractive"), QStringLiteral("-Command"), script}, env);
#endif
}

QJsonObject clickInput(const QJsonObject &params)
{
    const int x = params.value(QStringLiteral("x")).toInt(-1);
    const int y = params.value(QStringLiteral("y")).toInt(-1);
    if (x < 0 || y < 0 || x > 100'000 || y > 100'000) return failure(QStringLiteral("클릭 좌표가 유효하지 않습니다."));
#ifdef Q_OS_MACOS
    return run(QStringLiteral("/usr/bin/osascript"),
               {QStringLiteral("-e"), QStringLiteral("tell application \"System Events\" to click at {%1, %2}").arg(x).arg(y)});
#else
    QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
    env.insert(QStringLiteral("TERMES_X"), QString::number(x)); env.insert(QStringLiteral("TERMES_Y"), QString::number(y));
    const QString script = QStringLiteral("Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position=New-Object System.Drawing.Point([int]$env:TERMES_X,[int]$env:TERMES_Y); Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class M{[DllImport(\"user32.dll\")]public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e);}';[M]::mouse_event(2,0,0,0,[UIntPtr]::Zero);[M]::mouse_event(4,0,0,0,[UIntPtr]::Zero)");
    return run(QStringLiteral("powershell.exe"), {QStringLiteral("-NoProfile"), QStringLiteral("-NonInteractive"), QStringLiteral("-Command"), script}, env);
#endif
}

QJsonObject typeInputText(const QJsonObject &params)
{
    QString error;
    const QString text = inputTextValue(params, &error);
    if (!error.isEmpty()) return failure(error);
#ifdef Q_OS_MACOS
    const QString script = QStringLiteral("on run argv\n tell application \"System Events\" to keystroke (item 1 of argv)\nend run");
    QJsonObject result = run(QStringLiteral("/usr/bin/osascript"), {QStringLiteral("-e"), script, QStringLiteral("--"), text});
#else
    QVector<INPUT> inputs;
    inputs.reserve(text.size() * 2);
    for (const QChar character : text) {
        INPUT down{};
        down.type = INPUT_KEYBOARD;
        down.ki.wScan = character.unicode();
        down.ki.dwFlags = KEYEVENTF_UNICODE;
        INPUT up = down;
        up.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
        inputs.append(down);
        inputs.append(up);
    }
    const UINT sent = SendInput(UINT(inputs.size()), inputs.data(), sizeof(INPUT));
    QJsonObject result = sent == UINT(inputs.size())
        ? success()
        : failure(QStringLiteral("Unicode SendInput이 입력을 완료하지 못했습니다 (오류 %1).")
                      .arg(GetLastError()));
#endif
    if (result.value(QStringLiteral("status")).toString() == QLatin1String("completed")) result.insert(QStringLiteral("stdout"), QStringLiteral("Typed %1 characters").arg(text.size()));
    return result;
}

QJsonObject launchApp(const QJsonObject &params)
{
    QString error;
    const QString id = requiredString(params, QStringLiteral("appId"), 260, &error);
    if (!error.isEmpty()) return failure(error);
    if (!validIdentifier(id)) return failure(QStringLiteral("appId에 지원하지 않는 문자가 있습니다."));
#ifdef Q_OS_MACOS
    return run(QStringLiteral("/usr/bin/open"), {QStringLiteral("-b"), id});
#else
    return run(QStringLiteral("explorer.exe"), {QStringLiteral("shell:AppsFolder\\%1").arg(id)});
#endif
}

QJsonObject terminateApp(const QJsonObject &params)
{
    QString error;
    const qint64 pid = requiredPid(params, &error);
    if (!error.isEmpty()) return failure(error);
#ifdef Q_OS_MACOS
    return run(QStringLiteral("/bin/kill"), {QStringLiteral("-TERM"), QString::number(pid)});
#else
    return run(QStringLiteral("taskkill.exe"), {QStringLiteral("/PID"), QString::number(pid)});
#endif
}

QJsonObject queryLogs(const QJsonObject &params)
{
#ifdef Q_OS_MACOS
    const int minutes = boundedInt(params, QStringLiteral("minutes"), 5, 1, 60);
    QStringList args{QStringLiteral("show"), QStringLiteral("--style"), QStringLiteral("json"), QStringLiteral("--last"), QStringLiteral("%1m").arg(minutes)};
    const QString process = params.value(QStringLiteral("process")).toString().trimmed();
    if (!process.isEmpty()) {
        if (process.size() > 120 || !validIdentifier(process)) return failure(QStringLiteral("프로세스 필터가 유효하지 않습니다."));
        args << QStringLiteral("--predicate") << QStringLiteral("process == '%1'").arg(process);
    }
    return run(QStringLiteral("/usr/bin/log"), args, QProcessEnvironment::systemEnvironment(),
               LogsQueryProcessTimeoutMs);
#else
    const QString logName = params.value(QStringLiteral("logName")).toString(QStringLiteral("System"));
    if (logName != QLatin1String("System") && logName != QLatin1String("Application")) return failure(QStringLiteral("logName은 System 또는 Application이어야 합니다."));
    QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
    env.insert(QStringLiteral("TERMES_LOG_NAME"), logName); env.insert(QStringLiteral("TERMES_MAX_EVENTS"), QString::number(boundedInt(params, QStringLiteral("maxEvents"), 100, 1, 200)));
    const QString script = QStringLiteral("Get-WinEvent -LogName $env:TERMES_LOG_NAME -MaxEvents ([int]$env:TERMES_MAX_EVENTS)|Select-Object TimeCreated,Id,LevelDisplayName,ProviderName,Message|ConvertTo-Json -Depth 4 -Compress");
    return run(QStringLiteral("powershell.exe"), {QStringLiteral("-NoProfile"), QStringLiteral("-NonInteractive"), QStringLiteral("-Command"), script}, env);
#endif
}

QJsonObject debugProcess(const QJsonObject &params)
{
    QString error;
    const qint64 pid = requiredPid(params, &error);
    if (!error.isEmpty()) return failure(error);
#ifdef Q_OS_MACOS
    return run(QStringLiteral("/usr/bin/sample"), {QString::number(pid), QStringLiteral("1"), QStringLiteral("1")}, QProcessEnvironment::systemEnvironment(), 10'000);
#else
    QProcessEnvironment env = QProcessEnvironment::systemEnvironment(); env.insert(QStringLiteral("TERMES_PID"), QString::number(pid));
    const QString script = QStringLiteral("Get-Process -Id ([int]$env:TERMES_PID)|Select-Object Id,Name,Path,StartTime,Handles,Threads,WorkingSet64,PrivateMemorySize64,TotalProcessorTime|ConvertTo-Json -Depth 3 -Compress");
    return run(QStringLiteral("powershell.exe"), {QStringLiteral("-NoProfile"), QStringLiteral("-NonInteractive"), QStringLiteral("-Command"), script}, env);
#endif
}
}

QString PlatformAdapter::inputText(const QJsonObject &params, QString *error)
{
    return inputTextValue(params, error);
}

QString PlatformAdapter::platformName()
{
#ifdef Q_OS_WIN
    return QStringLiteral("windows");
#else
    return QStringLiteral("macos");
#endif
}

QString PlatformAdapter::actionPrefix()
{
    return platformName();
}

QStringList PlatformAdapter::capabilities()
{
    const QString prefix = actionPrefix() + QLatin1Char('.');
    return {prefix + QStringLiteral("system.info"), prefix + QStringLiteral("process.list"),
            prefix + QStringLiteral("screen.capture"), prefix + QStringLiteral("accessibility.snapshot"),
            prefix + QStringLiteral("input.click"), prefix + QStringLiteral("input.type"),
            prefix + QStringLiteral("app.launch"), prefix + QStringLiteral("app.terminate"),
            prefix + QStringLiteral("logs.query"), prefix + QStringLiteral("debug.process")};
}

bool PlatformAdapter::isReadOnly(const QString &action)
{
    return action.endsWith(QStringLiteral(".system.info")) || action.endsWith(QStringLiteral(".process.list"));
}

qint64 PlatformAdapter::executionBudgetMs(const QString &action)
{
    constexpr qint64 ProcessStartupAndCleanupMs = 7'000;
    constexpr qint64 ResultTransportMs = 5'000;
    qint64 executionMs = DefaultProcessTimeoutMs;
    if (action.endsWith(QStringLiteral(".logs.query"))) executionMs = LogsQueryProcessTimeoutMs;
    else if (action.endsWith(QStringLiteral(".debug.process"))) executionMs = 10'000;
    return ProcessStartupAndCleanupMs + executionMs + ResultTransportMs;
}

QVariantMap PlatformAdapter::permissionState()
{
#ifdef Q_OS_MACOS
    const bool accessibility = AXIsProcessTrusted();
    const bool screen = CGPreflightScreenCaptureAccess();
    return {{QStringLiteral("accessibility"), accessibility ? QStringLiteral("granted") : QStringLiteral("denied")},
            {QStringLiteral("screenCapture"), screen ? QStringLiteral("granted") : QStringLiteral("denied")},
            {QStringLiteral("inputControl"), accessibility ? QStringLiteral("granted") : QStringLiteral("denied")},
            {QStringLiteral("processInspection"), QStringLiteral("granted")}};
#else
    return {{QStringLiteral("accessibility"), QStringLiteral("granted")},
            {QStringLiteral("screenCapture"), QStringLiteral("granted")},
            {QStringLiteral("inputControl"), QStringLiteral("granted")},
            {QStringLiteral("processInspection"), QStringLiteral("granted")}};
#endif
}

bool PlatformAdapter::requestPermission(const QString &kind, QString *error)
{
#ifdef Q_OS_MACOS
    if (kind == QLatin1String("accessibility") || kind == QLatin1String("inputControl")) {
        const void *keys[] = {kAXTrustedCheckOptionPrompt};
        const void *values[] = {kCFBooleanTrue};
        CFDictionaryRef options = CFDictionaryCreate(nullptr, keys, values, 1,
            &kCFCopyStringDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
        AXIsProcessTrustedWithOptions(options);
        CFRelease(options);
        return true;
    }
    if (kind == QLatin1String("screenCapture")) {
        if (CGRequestScreenCaptureAccess()) return true;
        return openPermissionSettings(kind, error);
    }
    if (error) *error = QStringLiteral("알 수 없는 권한 종류입니다.");
    return false;
#else
    Q_UNUSED(kind)
    if (error) *error = QStringLiteral("Windows는 이 기능에 별도 권한 요청 창을 제공하지 않습니다.");
    return false;
#endif
}

bool PlatformAdapter::openPermissionSettings(const QString &kind, QString *error)
{
#ifdef Q_OS_MACOS
    QString url;
    if (kind == QLatin1String("accessibility") || kind == QLatin1String("inputControl"))
        url = QStringLiteral("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
    else if (kind == QLatin1String("screenCapture"))
        url = QStringLiteral("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
    else {
        if (error) *error = QStringLiteral("알 수 없는 권한 종류입니다.");
        return false;
    }
    if (!QDesktopServices::openUrl(QUrl(url))) {
        if (error) *error = QStringLiteral("macOS 시스템 설정을 열 수 없습니다.");
        return false;
    }
    return true;
#else
    Q_UNUSED(kind)
    if (error) *error = QStringLiteral("Windows는 이 기능에 별도 권한 설정 페이지를 제공하지 않습니다.");
    return false;
#endif
}

QJsonObject PlatformAdapter::execute(
    const QString &action,
    const QJsonObject &params,
    const std::shared_ptr<ExecutionCancellation> &cancellation)
{
    if (cancellation && cancellation->isCancelled()) return cancelledResult();
    CancellationScope cancellationScope(cancellation);
    if (!capabilities().contains(action)) return failure(QStringLiteral("지원하지 않는 Connector 작업입니다: %1").arg(action));
    const QString suffix = action.mid(actionPrefix().size() + 1);
    QJsonObject result;
    if (suffix == QLatin1String("system.info")) result = systemInfo();
    else if (suffix == QLatin1String("process.list")) result = processList();
    else if (suffix == QLatin1String("screen.capture")) result = screenCapture();
    else if (suffix == QLatin1String("accessibility.snapshot")) result = accessibilitySnapshot(params);
    else if (suffix == QLatin1String("input.click")) result = clickInput(params);
    else if (suffix == QLatin1String("input.type")) result = typeInputText(params);
    else if (suffix == QLatin1String("app.launch")) result = launchApp(params);
    else if (suffix == QLatin1String("app.terminate")) result = terminateApp(params);
    else if (suffix == QLatin1String("logs.query")) result = queryLogs(params);
    else if (suffix == QLatin1String("debug.process")) result = debugProcess(params);
    else result = failure(QStringLiteral("지원하지 않는 Connector 작업입니다: %1").arg(action));
    return cancelled() ? cancelledResult() : result;
}
