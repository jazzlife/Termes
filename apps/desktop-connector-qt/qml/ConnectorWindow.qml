pragma ComponentBehavior: Bound

import QtQuick
import QtQuick.Controls.Basic

ApplicationWindow {
    id: root
    width: 720
    height: 480
    minimumWidth: 720
    maximumWidth: 720
    minimumHeight: 480
    maximumHeight: 480
    visible: true
    title: "Termes Connector"
    color: "#0b0d10"
    font.family: fontUi
    onActiveChanged: if (active) connector.refreshPermissions()

    readonly property string fontUi: ".AppleSystemUIFont"
    readonly property string fontMono: "Menlo"
    readonly property color surfaceApp: "#0b0d10"
    readonly property color surfacePanel: "#11151a"
    readonly property color surfaceMuted: "#0e1216"
    readonly property color border: "#28313a"
    readonly property color borderSubtle: "#20272e"
    readonly property color textPrimary: "#e8edf3"
    readonly property color textSecondary: "#9ba8b5"
    readonly property color textMuted: "#65727e"
    readonly property color accent: "#58e2a0"
    readonly property color danger: "#ff858d"
    readonly property color warning: "#f4bd59"

    function phaseLabel() {
        if (connector.phase === "online") return "온라인"
        if (connector.phase === "busy") return "제어 실행 중"
        if (connector.phase === "connecting") return "연결 중"
        if (connector.phase === "error") return "연결 오류"
        if (connector.phase === "offline") return "오프라인"
        return "연결 안 됨"
    }

    function phaseColor() {
        if (connector.phase === "online" || connector.phase === "busy") return accent
        if (connector.phase === "connecting") return warning
        if (connector.phase === "error") return danger
        return textSecondary
    }

    function permissionLabel(value) {
        if (value === "granted") return "허용됨"
        if (value === "denied") return "허용 필요"
        if (value === "not_determined") return "확인 필요"
        return "시스템 기본"
    }

    function permissionColor(value) {
        if (value === "granted") return accent
        if (value === "denied" || value === "not_determined") return danger
        return textSecondary
    }

    function activityStatus(success) {
        if (success === true) return "성공"
        if (success === false) return "실패"
        return "정보"
    }

    component UiButton: Button {
        id: control
        property string variant: "secondary"
        hoverEnabled: true
        implicitHeight: 44
        implicitWidth: contentText.implicitWidth + 30
        leftPadding: 15
        rightPadding: 15
        font.family: root.fontUi
        font.pixelSize: 11
        font.weight: Font.Bold
        contentItem: Text {
            id: contentText
            text: control.text
            color: control.variant === "danger" ? root.danger
                 : control.variant === "primary" ? "#07110c"
                 : root.textPrimary
            font: control.font
            horizontalAlignment: Text.AlignHCenter
            verticalAlignment: Text.AlignVCenter
        }
        background: Rectangle {
            radius: 9
            color: control.variant === "danger"
                   ? (control.hovered ? "#321920" : "#1d1116")
                   : control.variant === "primary"
                     ? (control.hovered ? "#70e9ae" : root.accent)
                     : control.hovered ? "#1a2027" : "#151a20"
            border.width: 1
            border.color: control.variant === "danger" ? "#713940"
                        : control.variant === "primary" ? "#65e7a8"
                        : control.hovered ? "#46515c" : "#313b44"
        }
    }

    component TextAction: Button {
        id: control
        property bool muted: false
        hoverEnabled: true
        implicitHeight: 22
        implicitWidth: label.implicitWidth
        leftPadding: 0
        rightPadding: 0
        contentItem: Text {
            id: label
            text: control.text
            color: control.muted ? (control.hovered ? "#a6b1bb" : "#778592")
                                 : (control.hovered ? "#a2ebc4" : "#7fdcae")
            font.family: root.fontUi
            font.pixelSize: 10
            font.weight: Font.DemiBold
            horizontalAlignment: Text.AlignHCenter
            verticalAlignment: Text.AlignVCenter
        }
        background: Item {}
    }

    component TextEntry: TextField {
        id: input
        implicitHeight: 36
        color: root.textPrimary
        placeholderTextColor: "#566675"
        font.family: root.fontUi
        font.pixelSize: 12
        leftPadding: 11
        rightPadding: 11
        selectionColor: root.accent
        selectedTextColor: "#07100d"
        background: Rectangle {
            radius: 9
            color: root.surfaceMuted
            border.width: input.activeFocus ? 1.5 : 1
            border.color: input.activeFocus ? root.accent : "#2c353e"
        }
    }

    component StatusPill: Rectangle {
        implicitWidth: statusText.implicitWidth + 34
        implicitHeight: 36
        radius: 18
        color: Qt.alpha(root.phaseColor(), 0.09)
        border.width: 1
        border.color: Qt.alpha(root.phaseColor(), 0.42)
        Row {
            anchors.centerIn: parent
            spacing: 8
            Rectangle {
                anchors.verticalCenter: parent.verticalCenter
                width: 7
                height: 7
                radius: 3.5
                color: root.phaseColor()
            }
            Text {
                id: statusText
                text: root.phaseLabel()
                color: root.phaseColor()
                font.family: root.fontUi
                font.pixelSize: 11
                font.weight: Font.DemiBold
            }
        }
    }

    component PermissionRow: Item {
        id: row
        required property string permissionKind
        required property string label
        property string value: connector.permissions[permissionKind] || "unsupported"
        property bool needsAction: value === "denied" || value === "not_determined"
        width: 242
        height: 58

        Rectangle {
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            height: 1
            color: root.borderSubtle
        }
        Rectangle {
            x: 0
            y: 25
            width: 8
            height: 8
            radius: 4
            color: root.permissionColor(row.value)
        }
        Text {
            x: 21
            y: 21
            text: row.label
            color: "#bfc8d1"
            font.family: root.fontUi
            font.pixelSize: 11
            font.weight: Font.DemiBold
        }
        Text {
            anchors.right: parent.right
            y: row.needsAction ? 12 : 21
            text: root.permissionLabel(row.value)
            color: root.permissionColor(row.value)
            font.family: root.fontUi
            font.pixelSize: 9
            font.weight: Font.Bold
        }
        Row {
            visible: row.needsAction
            anchors.right: parent.right
            y: 29
            spacing: 10
            TextAction {
                text: "권한 요청"
                onClicked: connector.requestPermission(row.permissionKind)
            }
            TextAction {
                text: "설정"
                muted: true
                onClicked: connector.openPermissionSettings(row.permissionKind)
            }
        }
    }

    Canvas {
        anchors.fill: parent
        onWidthChanged: requestPaint()
        onHeightChanged: requestPaint()
        onPaint: {
            const ctx = getContext("2d")
            ctx.reset()
            ctx.fillStyle = root.surfaceApp
            ctx.fillRect(0, 0, width, height)
            let green = ctx.createRadialGradient(0, 0, 0, 0, 0, 420)
            green.addColorStop(0, "rgba(70,229,159,0.08)")
            green.addColorStop(1, "rgba(70,229,159,0)")
            ctx.fillStyle = green
            ctx.fillRect(0, 0, width, height)
            let blue = ctx.createRadialGradient(width, height * 0.25, 0, width, height * 0.25, 480)
            blue.addColorStop(0, "rgba(83,124,255,0.07)")
            blue.addColorStop(1, "rgba(83,124,255,0)")
            ctx.fillStyle = blue
            ctx.fillRect(0, 0, width, height)
        }
    }

    Item {
        id: topbar
        x: 24
        y: 0
        width: 672
        height: 76

        Rectangle {
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            height: 1
            color: root.borderSubtle
        }
        Image {
            x: 0
            y: 18
            width: 40
            height: 40
            source: "qrc:/qt/qml/TermesConnector/assets/termes-icon.png"
            fillMode: Image.PreserveAspectFit
            smooth: true
        }
        Text {
            x: 53
            y: 21
            text: "Termes Connector"
            color: root.textPrimary
            font.family: root.fontUi
            font.pixelSize: 15
            font.weight: Font.Bold
        }
        Text {
            x: 53
            y: 43
            text: "WINDOWS · MACOS"
            color: "#677583"
            font.family: root.fontUi
            font.pixelSize: 11
            font.letterSpacing: 0.9
        }
        Button {
            id: activityButton
            x: parent.width - width
            y: 16
            width: 90
            height: 44
            hoverEnabled: true
            Accessible.role: Accessible.Button
            Accessible.name: "활동 기록"
            onClicked: activityPopup.open()
            background: Rectangle {
                radius: 9
                color: activityButton.hovered ? "#161b21" : root.surfacePanel
                border.width: 1
                border.color: activityButton.hovered ? "#3a4651" : root.border
            }
            contentItem: Item {
                Canvas {
                    x: 14
                    y: 14
                    width: 16
                    height: 16
                    onPaint: {
                        const ctx = getContext("2d")
                        ctx.clearRect(0, 0, width, height)
                        ctx.strokeStyle = "#82909f"
                        ctx.lineWidth = 1.4
                        ctx.beginPath()
                        ctx.moveTo(0, 8)
                        ctx.lineTo(4, 8)
                        ctx.lineTo(6.5, 2)
                        ctx.lineTo(10, 14)
                        ctx.lineTo(12.5, 8)
                        ctx.lineTo(16, 8)
                        ctx.stroke()
                    }
                }
                Text {
                    x: 37
                    anchors.verticalCenter: parent.verticalCenter
                    text: "활동 기록"
                    color: "#d3dbe3"
                    font.family: root.fontUi
                    font.pixelSize: 11
                    font.weight: Font.Bold
                }
            }
        }
    }

    Rectangle {
        id: errorBanner
        visible: connector.lastError.length > 0
        z: 10
        x: 24
        y: 82
        width: 672
        height: 42
        radius: 11
        color: "#261318"
        border.width: 1
        border.color: "#623039"
        Text {
            x: 15
            anchors.verticalCenter: parent.verticalCenter
            width: parent.width - 76
            text: "연결을 확인해 주세요.  " + connector.lastError
            color: "#ffabb0"
            font.family: root.fontUi
            font.pixelSize: 11
            elide: Text.ElideRight
        }
        TextAction {
            anchors.right: parent.right
            anchors.rightMargin: 15
            anchors.verticalCenter: parent.verticalCenter
            text: "닫기"
            muted: true
            onClicked: connector.clearError()
        }
    }

    Item {
        id: connectedWorkspace
        visible: connector.paired
        x: 24
        y: 98
        width: 672
        height: 382

        Item {
            id: connectionPane
            x: 0
            y: 0
            width: 402
            height: parent.height

            Rectangle {
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.bottom: parent.bottom
                width: 1
                color: root.borderSubtle
            }
            Text {
                x: 0
                y: 7
                text: "현재 연결"
                color: root.accent
                font.family: root.fontUi
                font.pixelSize: 10
                font.weight: Font.Bold
                font.letterSpacing: 1.1
            }
            Text {
                x: 0
                y: 31
                width: 285
                text: connector.settings.deviceName || "-"
                color: root.textPrimary
                font.family: root.fontUi
                font.pixelSize: 25
                font.weight: Font.Bold
                font.letterSpacing: -1
                elide: Text.ElideRight
            }
            StatusPill {
                x: 374 - width
                y: 29
            }

            Item {
                id: identityList
                x: 0
                y: 79
                width: 374
                height: 126
                Repeater {
                    model: [
                        { label: "Workspace", value: connector.settings.workspaceKey || "-", mono: true },
                        { label: "Project", value: connector.settings.projectName || "-", mono: false },
                        { label: "Connector ID", value: connector.settings.connectorId || "-", mono: true }
                    ]
                    delegate: Item {
                        required property var modelData
                        required property int index
                        x: 0
                        y: index * 42
                        width: 374
                        height: 42
                        Rectangle {
                            anchors.left: parent.left
                            anchors.right: parent.right
                            anchors.bottom: parent.bottom
                            height: 1
                            color: root.borderSubtle
                        }
                        Text {
                            anchors.left: parent.left
                            anchors.verticalCenter: parent.verticalCenter
                            text: modelData.label
                            color: root.textMuted
                            font.family: root.fontUi
                            font.pixelSize: 10
                        }
                        Text {
                            anchors.right: parent.right
                            anchors.verticalCenter: parent.verticalCenter
                            width: modelData.label === "Connector ID" ? 260 : 210
                            text: modelData.value
                            color: "#b8c2cc"
                            font.family: modelData.mono ? root.fontMono : root.fontUi
                            font.pixelSize: 10
                            font.weight: Font.DemiBold
                            horizontalAlignment: Text.AlignRight
                            elide: Text.ElideMiddle
                        }
                    }
                }
            }

            Row {
                x: 0
                y: 224
                spacing: 8
                UiButton {
                    text: connector.phase === "online" || connector.phase === "busy" ? "연결 끊기" : "다시 연결"
                    onClicked: connector.phase === "online" || connector.phase === "busy"
                               ? connector.disconnectConnector() : connector.connectConnector()
                }
                UiButton {
                    text: "즉시 중단"
                    variant: "danger"
                    onClicked: connector.emergencyStop()
                }
            }

            Item {
                id: autoObserveToggle
                x: 0
                y: 283
                width: 374
                height: 52
                Rectangle {
                    x: 1
                    y: 8
                    width: 13
                    height: 13
                    radius: 2
                    color: connector.settings.autoObserve === true ? root.accent : "#f2f3f4"
                    border.width: 1
                    border.color: connector.settings.autoObserve === true ? root.accent : "#c8cdd2"
                    Text {
                        anchors.centerIn: parent
                        visible: connector.settings.autoObserve === true
                        text: "✓"
                        color: "#07110c"
                        font.pixelSize: 10
                        font.weight: Font.Bold
                    }
                }
                Text {
                    x: 25
                    y: 4
                    text: "읽기 전용 분석 자동 허용"
                    color: "#b9c3cc"
                    font.family: root.fontUi
                    font.pixelSize: 11
                    font.weight: Font.DemiBold
                }
                Text {
                    x: 25
                    y: 24
                    width: 345
                    text: "시스템·프로세스·화면 분석만 자동 승인합니다. 제어 작업은 항상 묻습니다."
                    color: root.textMuted
                    font.family: root.fontUi
                    font.pixelSize: 9
                    elide: Text.ElideRight
                }
                MouseArea {
                    anchors.fill: parent
                    cursorShape: Qt.PointingHandCursor
                    onClicked: connector.setAutoObserve(!(connector.settings.autoObserve === true))
                }
            }

            Button {
                id: forgetButton
                x: 0
                y: 342
                width: 170
                height: 40
                hoverEnabled: true
                onClicked: forgetPopup.open()
                background: Item {}
                contentItem: Text {
                    text: "이 PC에서 연결 정보 삭제"
                    color: forgetButton.hovered ? "#ff939a" : "#d5787e"
                    font.family: root.fontUi
                    font.pixelSize: 10
                    horizontalAlignment: Text.AlignLeft
                    verticalAlignment: Text.AlignVCenter
                }
            }
        }

        Item {
            id: permissionsPane
            x: 402
            y: 0
            width: 270
            height: parent.height

            Text {
                x: 28
                y: 7
                text: "로컬 권한"
                color: root.accent
                font.family: root.fontUi
                font.pixelSize: 10
                font.weight: Font.Bold
                font.letterSpacing: 1.1
            }
            Text {
                x: 28
                y: 31
                text: "PC 접근 범위"
                color: root.textPrimary
                font.family: root.fontUi
                font.pixelSize: 16
                font.weight: Font.Bold
            }
            TextAction {
                x: parent.width - 28 - width
                y: 5
                text: "새로고침"
                onClicked: connector.refreshPermissions()
            }
            Item {
                x: 28
                y: 61
                width: 242
                height: 232
                PermissionRow { y: 0; permissionKind: "accessibility"; label: "화면 요소 분석" }
                PermissionRow { y: 58; permissionKind: "screenCapture"; label: "화면 캡처" }
                PermissionRow { y: 116; permissionKind: "inputControl"; label: "키보드와 포인터" }
                PermissionRow { y: 174; permissionKind: "processInspection"; label: "프로세스와 진단" }
            }
        }
    }

    Item {
        id: pairingWorkspace
        visible: !connector.paired
        x: 24
        y: 98
        width: 672
        height: 382

        Item {
            x: 0
            y: 31
            width: 310
            height: 310
            Text {
                x: 0
                y: 0
                text: "워크스페이스 연결"
                color: root.accent
                font.family: root.fontUi
                font.pixelSize: 10
                font.weight: Font.Bold
                font.letterSpacing: 1.2
            }
            Text {
                x: 0
                y: 26
                width: 310
                text: "이 PC를 Termes의\n안전한 작업 도구로 연결"
                color: root.textPrimary
                font.family: root.fontUi
                font.pixelSize: 29
                font.weight: Font.Bold
                font.letterSpacing: -1.2
                lineHeight: 0.96
            }
            Text {
                x: 0
                y: 104
                width: 302
                text: "연결은 이 앱에서 Termes로만 시작됩니다. 요청된 작업은 로컬 승인과 권한 검사를 통과한 뒤 실행되며, 언제든 즉시 중단할 수 있습니다."
                color: "#8d9aa7"
                font.family: root.fontUi
                font.pixelSize: 11
                wrapMode: Text.WordWrap
                lineHeight: 1.45
            }
            Column {
                x: 0
                y: 182
                spacing: 11
                Repeater {
                    model: [
                        "외부에서 PC로 들어오는 포트를 열지 않습니다.",
                        "연결 자격 증명은 OS 보안 저장소에 보관됩니다.",
                        "암호 입력·보안 권한 창은 자동 제어하지 않습니다."
                    ]
                    delegate: Row {
                        required property string modelData
                        spacing: 9
                        Text { text: "✓"; color: root.accent; font.pixelSize: 11; font.weight: Font.Bold }
                        Text { text: modelData; color: root.textSecondary; font.family: root.fontUi; font.pixelSize: 10 }
                    }
                }
            }
        }

        Rectangle {
            x: 356
            y: 3
            width: 316
            height: 365
            radius: 18
            color: "#11151a"
            border.width: 1
            border.color: "#232a31"

            Text {
                anchors.right: parent.right
                anchors.rightMargin: 28
                y: 22
                text: "01"
                color: "#47515b"
                font.family: root.fontMono
                font.pixelSize: 12
            }
            Text {
                x: 28
                y: 22
                text: "페어링 코드 입력"
                color: root.textPrimary
                font.family: root.fontUi
                font.pixelSize: 20
                font.weight: Font.Bold
            }
            Text {
                x: 28
                y: 51
                text: "Termes의 Devices 화면에서 일회용 코드를 생성하세요."
                color: "#788693"
                font.family: root.fontUi
                font.pixelSize: 10
            }
            Text { x: 28; y: 82; text: "Termes 주소"; color: "#a9b3bd"; font.family: root.fontUi; font.pixelSize: 10; font.weight: Font.DemiBold }
            TextEntry { id: apiInput; x: 28; y: 100; width: 260; placeholderText: "https://termes.example.com" }
            Text { x: 28; y: 145; text: "PC 이름"; color: "#a9b3bd"; font.family: root.fontUi; font.pixelSize: 10; font.weight: Font.DemiBold }
            TextEntry { id: nameInput; x: 28; y: 163; width: 260; text: connector.defaultDeviceName }
            Text { x: 28; y: 208; text: "일회용 코드"; color: "#a9b3bd"; font.family: root.fontUi; font.pixelSize: 10; font.weight: Font.DemiBold }
            TextEntry {
                id: codeInput
                x: 28
                y: 226
                width: 260
                height: 44
                placeholderText: "ABCD-EFGH"
                horizontalAlignment: TextInput.AlignHCenter
                font.family: root.fontMono
                font.pixelSize: 18
                font.letterSpacing: 2
                inputMethodHints: Qt.ImhUppercaseOnly | Qt.ImhNoPredictiveText
            }
            UiButton {
                x: 28
                y: 290
                width: 260
                height: 45
                variant: "primary"
                text: connector.actionBusy ? "연결 확인 중…" : "워크스페이스에 연결"
                enabled: !connector.actionBusy
                onClicked: connector.pairConnector(apiInput.text, codeInput.text, nameInput.text)
            }
        }
    }

    Popup {
        id: activityPopup
        parent: Overlay.overlay
        x: 24
        y: 24
        width: 672
        height: 432
        modal: true
        focus: true
        padding: 0
        closePolicy: Popup.CloseOnEscape | Popup.CloseOnPressOutside
        Overlay.modal: Rectangle { color: "#050608d1" }
        background: Rectangle {
            radius: 14
            color: root.surfacePanel
            border.width: 1
            border.color: root.border
        }
        contentItem: Item {
            Text {
                x: 26
                y: 22
                text: "모니터링"
                color: root.accent
                font.family: root.fontUi
                font.pixelSize: 10
                font.weight: Font.Bold
                font.letterSpacing: 1.2
            }
            Text {
                x: 26
                y: 43
                text: "활동 기록"
                color: root.textPrimary
                font.family: root.fontUi
                font.pixelSize: 20
                font.weight: Font.Bold
            }
            Button {
                id: closeActivityButton
                x: parent.width - 70
                y: 18
                width: 44
                height: 44
                hoverEnabled: true
                onClicked: activityPopup.close()
                background: Rectangle { radius: 9; color: closeActivityButton.hovered ? "#181e24" : root.surfaceMuted }
                contentItem: Text { text: "×"; color: root.textSecondary; font.pixelSize: 24; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter }
            }
            Row {
                x: 26
                y: 80
                spacing: 8
                Rectangle { anchors.verticalCenter: parent.verticalCenter; width: 7; height: 7; radius: 3.5; color: root.accent }
                Text { text: "현재 세션 · " + connector.activities.length + "건"; color: "#8e9aa6"; font.family: root.fontUi; font.pixelSize: 10 }
            }
            Text {
                anchors.right: parent.right
                anchors.rightMargin: 26
                y: 78
                text: "실시간 업데이트"
                color: root.textSecondary
                font.family: root.fontUi
                font.pixelSize: 11
            }
            ListView {
                x: 26
                y: 110
                width: parent.width - 52
                height: parent.height - 132
                clip: true
                model: connector.activities
                delegate: Item {
                    required property var modelData
                    width: ListView.view.width
                    height: 48
                    Rectangle { anchors.left: parent.left; anchors.right: parent.right; anchors.bottom: parent.bottom; height: 1; color: root.borderSubtle }
                    Rectangle {
                        x: 0
                        y: 20
                        width: 7
                        height: 7
                        radius: 3.5
                        color: modelData.success === true ? root.accent : modelData.success === false ? root.danger : "#687480"
                    }
                    Text {
                        x: 19
                        y: 9
                        width: parent.width - 175
                        text: modelData.title
                        color: "#c3ccd5"
                        font.family: root.fontUi
                        font.pixelSize: 11
                        font.weight: Font.DemiBold
                        elide: Text.ElideRight
                    }
                    Text {
                        x: 19
                        y: 26
                        width: parent.width - 175
                        text: modelData.detail
                        color: root.textSecondary
                        font.family: root.fontUi
                        font.pixelSize: 10
                        elide: Text.ElideRight
                    }
                    Text {
                        anchors.right: parent.right
                        y: 8
                        text: root.activityStatus(modelData.success)
                        color: modelData.success === true ? root.accent : modelData.success === false ? root.danger : root.textSecondary
                        font.family: root.fontUi
                        font.pixelSize: 10
                        font.weight: Font.Bold
                    }
                    Text {
                        anchors.right: parent.right
                        y: 25
                        width: 145
                        text: modelData.at
                        color: root.textMuted
                        font.family: root.fontUi
                        font.pixelSize: 9
                        horizontalAlignment: Text.AlignRight
                        elide: Text.ElideLeft
                    }
                }
                Text {
                    anchors.centerIn: parent
                    visible: connector.activities.length === 0
                    text: "아직 기록된 작업이 없습니다."
                    color: root.textSecondary
                    font.family: root.fontUi
                    font.pixelSize: 11
                }
            }
        }
    }

    Popup {
        id: approvalPopup
        parent: Overlay.overlay
        visible: connector.pendingApprovals.length > 0
        x: 24
        y: root.height - height - 16
        width: 672
        height: 94
        modal: false
        closePolicy: Popup.NoAutoClose
        padding: 0
        property var command: connector.pendingApprovals.length > 0 ? connector.pendingApprovals[0] : ({})
        background: Rectangle { radius: 11; color: root.surfaceMuted; border.width: 1; border.color: root.warning }
        contentItem: Item {
            Text { x: 15; y: 14; text: "로컬 승인 요청"; color: root.warning; font.family: root.fontUi; font.pixelSize: 10; font.weight: Font.Bold }
            Text { x: 15; y: 34; width: 430; text: approvalPopup.command.action || ""; color: root.textPrimary; font.family: root.fontUi; font.pixelSize: 13; font.weight: Font.Bold; elide: Text.ElideRight }
            Text { x: 15; y: 56; width: 430; text: JSON.stringify(approvalPopup.command.params || {}); color: root.textSecondary; font.family: root.fontMono; font.pixelSize: 9; elide: Text.ElideRight }
            UiButton { x: 480; y: 25; width: 76; text: "거부"; onClicked: connector.rejectCommand(approvalPopup.command.commandId) }
            UiButton { x: 564; y: 25; width: 88; variant: "primary"; text: "이번 작업 허용"; onClicked: connector.approveCommand(approvalPopup.command.commandId) }
        }
    }

    Popup {
        id: forgetPopup
        parent: Overlay.overlay
        x: (root.width - width) / 2
        y: (root.height - height) / 2
        width: 420
        height: 190
        modal: true
        focus: true
        closePolicy: Popup.CloseOnEscape
        padding: 0
        Overlay.modal: Rectangle { color: "#050608d1" }
        background: Rectangle { radius: 14; color: root.surfacePanel; border.width: 1; border.color: root.border }
        contentItem: Item {
            Text { x: 24; y: 23; text: "연결 정보를 삭제할까요?"; color: root.textPrimary; font.family: root.fontUi; font.pixelSize: 18; font.weight: Font.Bold }
            Text { x: 24; y: 57; width: 372; text: "이 PC의 Connector 설정과 보안 자격 증명이 삭제됩니다. Termes 서버의 장치 레코드는 삭제되지 않습니다."; color: root.textSecondary; font.family: root.fontUi; font.pixelSize: 11; wrapMode: Text.WordWrap; lineHeight: 1.35 }
            UiButton { x: 222; y: 125; width: 80; text: "취소"; onClicked: forgetPopup.close() }
            UiButton { x: 310; y: 125; width: 86; variant: "danger"; text: "삭제"; onClicked: { forgetPopup.close(); connector.forgetConnector() } }
        }
    }
}
