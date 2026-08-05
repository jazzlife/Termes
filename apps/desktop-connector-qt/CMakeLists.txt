cmake_minimum_required(VERSION 3.21)

project(TermesConnectorQt VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)

include(GNUInstallDirs)

find_package(Qt6 6.5 REQUIRED COMPONENTS Concurrent Network Quick Test WebSockets)
qt_standard_project_setup(REQUIRES 6.5)
if(Qt6_VERSION VERSION_GREATER_EQUAL 6.8)
    qt_policy(SET QTP0004 NEW)
endif()

qt_add_executable(termes-connector-qt
    src/main.cpp
    src/connectorbackend.cpp
    src/connectorbackend.h
    src/credentialstore.cpp
    src/credentialstore.h
    src/platformadapter.cpp
    src/platformadapter.h
)

qt_add_qml_module(termes-connector-qt
    URI TermesConnector
    VERSION 1.0
    QML_FILES
        qml/ConnectorWindow.qml
    RESOURCES
        assets/termes-icon.png
)

target_link_libraries(termes-connector-qt PRIVATE
    Qt6::Concurrent
    Qt6::Network
    Qt6::Quick
    Qt6::WebSockets
)

if(APPLE)
    target_link_libraries(termes-connector-qt PRIVATE
        "-framework ApplicationServices"
        "-framework CoreGraphics"
        "-framework Security"
    )
elseif(WIN32)
    target_link_libraries(termes-connector-qt PRIVATE Advapi32)
endif()

set_target_properties(termes-connector-qt PROPERTIES
    MACOSX_BUNDLE TRUE
    MACOSX_BUNDLE_BUNDLE_NAME "Termes Connector Qt"
    MACOSX_BUNDLE_GUI_IDENTIFIER "app.turtlelab.termes.connector.qt"
    WIN32_EXECUTABLE TRUE
)

install(TARGETS termes-connector-qt
    BUNDLE DESTINATION .
    RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
)

if(APPLE)
    # Homebrew Qt's macdeployqt removes QML plugins when they are supplied as
    # additional executables. Deploy the runtime first, then copy the scanned
    # QML imports into the completed bundle.
    qt_generate_deploy_script(
        TARGET termes-connector-qt
        OUTPUT_SCRIPT deploy_script
        CONTENT "
qt6_deploy_runtime_dependencies(
    EXECUTABLE \"$<TARGET_FILE_NAME:termes-connector-qt>.app\"
    EXCLUDE_PLUGIN_TYPES imageformats iconengines platforminputcontexts
)
qt6_deploy_qml_imports(
    TARGET termes-connector-qt
    PLUGINS_FOUND qml_plugins
)

# Homebrew's QML tree is symlinked into its Cellar. Qt's deploy helper
# preserves those links with a relative target that is invalid inside an app
# bundle. Materialize the deployed imports before macdeployqt adjusts the QML
# plugin rpaths.
set(bundle_qml_dir
    \"\\\${QT_DEPLOY_PREFIX}/$<TARGET_FILE_NAME:termes-connector-qt>.app/Contents/Resources/qml\"
)
get_filename_component(qt_qml_root
    \"\\\${__QT_DEPLOY_QT_INSTALL_PREFIX}/\\\${__QT_DEPLOY_QT_INSTALL_DATA}/qml\"
    REALPATH
)
file(GLOB_RECURSE qt_qml_files
    RELATIVE \"\\\${qt_qml_root}\"
    LIST_DIRECTORIES FALSE
    \"\\\${qt_qml_root}/*\"
)
foreach(qt_qml_file IN LISTS qt_qml_files)
    set(deployed_qml_file \"\\\${bundle_qml_dir}/\\\${qt_qml_file}\")
    if(IS_SYMLINK \"\\\${deployed_qml_file}\")
        file(REMOVE \"\\\${deployed_qml_file}\")
        file(COPY_FILE
            \"\\\${qt_qml_root}/\\\${qt_qml_file}\"
            \"\\\${deployed_qml_file}\"
        )
    endif()
endforeach()

foreach(qml_plugin_link IN LISTS qml_plugins)
    if(NOT IS_ABSOLUTE \"\\\${qml_plugin_link}\")
        set(qml_plugin_link \"\\\${QT_DEPLOY_PREFIX}/\\\${qml_plugin_link}\")
    endif()
    if(IS_SYMLINK \"\\\${qml_plugin_link}\")
        get_filename_component(qml_plugin_name \"\\\${qml_plugin_link}\" NAME)
        file(GLOB_RECURSE qml_plugin_sources LIST_DIRECTORIES FALSE
            \"\\\${qt_qml_root}/*/\\\${qml_plugin_name}\"
        )
        list(LENGTH qml_plugin_sources qml_plugin_source_count)
        if(NOT qml_plugin_source_count EQUAL 1)
            message(FATAL_ERROR
                \"Expected one source for QML plugin \\\${qml_plugin_name}, found \\\${qml_plugin_source_count}\"
            )
        endif()
        list(GET qml_plugin_sources 0 qml_plugin_source)
        file(REMOVE \"\\\${qml_plugin_link}\")
        file(COPY_FILE \"\\\${qml_plugin_source}\" \"\\\${qml_plugin_link}\")
    endif()
endforeach()

qt6_deploy_runtime_dependencies(
    EXECUTABLE \"$<TARGET_FILE_NAME:termes-connector-qt>.app\"
    ADDITIONAL_MODULES \\\${qml_plugins}
    EXCLUDE_PLUGIN_TYPES imageformats iconengines platforminputcontexts
)
"
    )
else()
    qt_generate_deploy_qml_app_script(
        TARGET termes-connector-qt
        OUTPUT_SCRIPT deploy_script
        NO_UNSUPPORTED_PLATFORM_ERROR
    )
endif()
install(SCRIPT ${deploy_script})
include(CTest)
if(BUILD_TESTING)
    add_executable(termes-connector-qt-tests
        tests/backend_test.cpp
        src/connectorbackend.cpp
        src/connectorbackend.h
        src/credentialstore.cpp
        src/credentialstore.h
        src/platformadapter.cpp
        src/platformadapter.h
    )
    target_include_directories(termes-connector-qt-tests PRIVATE src)
    target_link_libraries(termes-connector-qt-tests PRIVATE
        Qt6::Concurrent
        Qt6::Gui
        Qt6::Network
        Qt6::Test
        Qt6::WebSockets
    )
    if(APPLE)
        target_link_libraries(termes-connector-qt-tests PRIVATE
            "-framework ApplicationServices"
            "-framework CoreGraphics"
            "-framework Security"
        )
    elseif(WIN32)
        target_link_libraries(termes-connector-qt-tests PRIVATE Advapi32)
    endif()
    add_test(NAME termes-connector-qt-tests COMMAND termes-connector-qt-tests)
endif()
