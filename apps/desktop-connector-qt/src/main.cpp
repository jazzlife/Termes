#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include <QQmlContext>

#include "connectorbackend.h"

int main(int argc, char *argv[])
{
    qputenv("QT_QUICK_CONTROLS_STYLE", QByteArrayLiteral("Basic"));
    QGuiApplication app(argc, argv);
    QCoreApplication::setOrganizationName(QStringLiteral("TurtleLab"));
    QCoreApplication::setApplicationName(QStringLiteral("Termes Connector Qt"));
    QCoreApplication::setApplicationVersion(QStringLiteral("0.1.0"));

    ConnectorBackend connector;
    QQmlApplicationEngine engine;
    engine.rootContext()->setContextProperty(QStringLiteral("connector"), &connector);
    QObject::connect(
        &engine,
        &QQmlApplicationEngine::objectCreationFailed,
        &app,
        [] { QCoreApplication::exit(EXIT_FAILURE); },
        Qt::QueuedConnection);
    engine.loadFromModule(QStringLiteral("TermesConnector"), QStringLiteral("ConnectorWindow"));
    return app.exec();
}
