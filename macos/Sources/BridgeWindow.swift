import AppKit
import SwiftUI

private enum Palette {
    static let background = Color(red: 0.059, green: 0.078, blue: 0.106)
    static let sidebar = Color(red: 0.043, green: 0.059, blue: 0.082)
    static let panel = Color(red: 0.087, green: 0.111, blue: 0.143)
    static let text = Color(red: 0.92, green: 0.95, blue: 0.96)
    static let secondary = Color(red: 0.56, green: 0.63, blue: 0.69)
    static let accent = Color(red: 0.37, green: 0.88, blue: 0.70)
    static let border = Color.white.opacity(0.07)
}

private enum Section: String, CaseIterable {
    case overview = "Overview", settings = "Settings", maintenance = "Maintenance"
    var icon: String {
        switch self { case .overview: "square.grid.2x2"; case .settings: "slider.horizontal.3"; case .maintenance: "wrench.and.screwdriver" }
    }
    var heading: String {
        switch self { case .overview: "Your bridge, at a glance."; case .settings: "Make yourself at home."; case .maintenance: "Keep things running." }
    }
    var description: String {
        switch self {
        case .overview: "A quiet connection between your Mac and Even Terminal."
        case .settings: "A few simple preferences for everyday use."
        case .maintenance: "Check your installation and manage its versions."
        }
    }
}

struct BridgeWindow: View {
    @ObservedObject var model: BridgeModel
    @State private var selection: Section = .overview
    @State private var confirmsRollback = false
    @State private var confirmsStop = false

    var body: some View {
        HStack(spacing: 0) {
            sidebar
            Rectangle().fill(Palette.border).frame(width: 1)
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    header
                    if model.preview {
                        notice("Preview only · controls are disabled", icon: "eye", color: Palette.secondary)
                    }
                    if let error = model.statusError {
                        notice(error + " Displayed status may be out of date.", icon: "exclamationmark.triangle", color: .orange)
                    }
                    if let snapshot = model.snapshot {
                        switch selection {
                        case .overview: overview(snapshot)
                        case .settings: settings(snapshot)
                        case .maintenance: maintenance(snapshot)
                        }
                    } else {
                        VStack(alignment: .leading, spacing: 16) {
                            HStack(spacing: 12) { ProgressView().controlSize(.small); Text("Reading your local bridge…").font(.system(size: 15, weight: .medium)) }
                            Text("This window checks the service without interrupting it.").font(.system(size: 13)).foregroundStyle(Palette.secondary)
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(24).panel()
                    }
                    if let action = model.busyAction {
                        HStack(spacing: 10) {
                            ProgressView().controlSize(.small)
                            Text(action == "diagnose" ? "Checking installation…" : "Applying your request…").font(.system(size: 12))
                        }.foregroundStyle(Palette.secondary)
                    }
                    if let text = model.notice {
                        notice(text, icon: "checkmark.circle", color: Palette.accent)
                    }
                    Spacer(minLength: 0)
                }.frame(maxWidth: 780, alignment: .leading).padding(.horizontal, 30).padding(.top, 51).padding(.bottom, 26)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
            }
        }
        .background(Palette.background)
        .foregroundStyle(Palette.text)
        .tint(Palette.accent)
        .preferredColorScheme(.dark)
        .alert("Unable to complete request", isPresented: Binding(get: { model.operationError != nil }, set: { if !$0 { model.operationError = nil } })) {
            Button("OK", role: .cancel) { model.operationError = nil }
        } message: { Text(model.operationError ?? "") }
        .alert("Stop the bridge?", isPresented: $confirmsStop) {
            Button("Cancel", role: .cancel) {}
            Button("Stop Bridge", role: .destructive) { model.perform("stop") }
        } message: { Text("Even Terminal will be unavailable until you start the bridge again. This does not change your launch-at-login preference.") }
        .alert("Restore the previous version?", isPresented: $confirmsRollback) {
            Button("Cancel", role: .cancel) {}
            Button("Restore Version") { model.perform("rollback") }
        } message: { Text("The bridge will restart with the previously installed version. Your settings and pairing are preserved. The controller will check again that no interaction is active.") }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "eyeglasses").font(.system(size: 23, weight: .medium)).foregroundStyle(Palette.accent)
                VStack(alignment: .leading, spacing: 1) {
                    Text("G2 Bridge").font(.system(size: 16, weight: .semibold))
                    Text("MAC COMPANION").font(.system(size: 8, weight: .semibold)).tracking(1.4).foregroundStyle(Palette.secondary)
                }
            }.padding(.horizontal, 21).padding(.top, 53).padding(.bottom, 36)
            VStack(spacing: 6) {
                ForEach(Section.allCases, id: \.self) { section in
                    Button { selection = section } label: {
                        HStack(spacing: 11) {
                            Image(systemName: section.icon).font(.system(size: 14)).frame(width: 19)
                            Text(section.rawValue).font(.system(size: 13, weight: selection == section ? .semibold : .medium))
                            Spacer(minLength: 0)
                        }.foregroundStyle(selection == section ? Palette.accent : Palette.secondary)
                            .padding(.horizontal, 12).frame(height: 39)
                            .background(selection == section ? Palette.accent.opacity(0.09) : Color.clear, in: RoundedRectangle(cornerRadius: 9))
                    }.buttonStyle(.plain).accessibilityIdentifier("navigation-" + section.rawValue.lowercased())
                }
            }.padding(.horizontal, 12)
            Spacer()
            VStack(alignment: .leading, spacing: 9) {
                HStack(spacing: 7) {
                    Circle().fill(model.statusError != nil ? Color.orange : (model.snapshot?.running == true ? Palette.accent : Palette.secondary)).frame(width: 6, height: 6)
                    Text(model.statusError != nil ? "Status unavailable" : (model.snapshot?.running == true ? "Service running" : model.snapshot == nil ? "Checking status" : "Service stopped"))
                        .font(.system(size: 11, weight: .medium))
                }
                Text("The service works independently\nof this window.").font(.system(size: 10)).foregroundStyle(Palette.secondary).lineSpacing(3)
                Text("G2 Bridge 1.0").font(.system(size: 10)).foregroundStyle(Palette.secondary.opacity(0.7)).padding(.top, 4)
            }.padding(.horizontal, 23).padding(.bottom, 25)
        }.frame(width: 187).background(Palette.sidebar)
    }

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 9) {
                Text(selection.rawValue.uppercased()).font(.system(size: 10, weight: .semibold)).tracking(1.8).foregroundStyle(Palette.accent)
                Text(selection.heading).font(.system(size: 25, weight: .semibold)).tracking(-0.6)
                Text(selection.description).font(.system(size: 12)).foregroundStyle(Palette.secondary)
            }
            Spacer(minLength: 4)
            Button { Task { await model.refresh() } } label: {
                Image(systemName: "arrow.clockwise").font(.system(size: 13, weight: .medium)).frame(width: 29, height: 29)
            }.buttonStyle(.plain).foregroundStyle(Palette.secondary).disabled(model.isRefreshing || model.busyAction != nil || model.preview)
                .help("Refresh status").accessibilityLabel("Refresh status").accessibilityIdentifier("refresh-status")
        }
    }

    private func overview(_ snapshot: BridgeSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 16) {
                ZStack {
                    RoundedRectangle(cornerRadius: 14).fill(statusColor(snapshot).opacity(0.10)).frame(width: 51, height: 51)
                    Image(systemName: snapshot.isReady ? "link" : snapshot.running ? "waveform.path" : "power")
                        .font(.system(size: 22, weight: .medium)).foregroundStyle(statusColor(snapshot))
                }
                VStack(alignment: .leading, spacing: 9) {
                    HStack {
                        Text(snapshot.title).font(.system(size: 19, weight: .semibold)).tracking(-0.3)
                        Spacer(minLength: 0)
                        Text(snapshot.running ? "RUNNING" : "STOPPED").font(.system(size: 8, weight: .bold)).tracking(0.9)
                            .foregroundStyle(statusColor(snapshot)).padding(.horizontal, 8).padding(.vertical, 5)
                            .background(statusColor(snapshot).opacity(0.10), in: Capsule())
                    }
                    Text(snapshot.message).font(.system(size: 12)).foregroundStyle(Palette.secondary).lineSpacing(4).fixedSize(horizontal: false, vertical: true)
                    if !snapshot.isReady && !snapshot.action.isEmpty && snapshot.action != snapshot.message {
                        Text(snapshot.action).font(.system(size: 11)).foregroundStyle(statusColor(snapshot)).lineSpacing(3)
                    }
                }
            }.padding(21).frame(maxWidth: .infinity, alignment: .leading).panel()

            HStack(spacing: 13) {
                connectionCard(title: "Mac connection", icon: "desktopcomputer", value: snapshot.desktopCompatible ? (snapshot.desktopAvailable ? "Available" : "App is closed") : "Check compatibility", available: snapshot.desktopCompatible && snapshot.desktopAvailable)
                connectionCard(title: "Private network", icon: "network", value: snapshot.networkAvailable ? "Available" : "Not available", available: snapshot.networkAvailable)
            }

            HStack(spacing: 10) {
                if snapshot.running {
                    Button { model.perform("restart") } label: { Label("Restart Bridge", systemImage: "arrow.clockwise") }
                        .buttonStyle(BridgeButtonStyle(primary: true)).disabled(!model.canMutate).accessibilityIdentifier("restart-bridge")
                    Button { confirmsStop = true } label: { Text("Stop") }
                        .buttonStyle(BridgeButtonStyle()).disabled(!model.canMutate).accessibilityIdentifier("stop-bridge")
                } else {
                    Button { model.perform("start") } label: { Label("Start Bridge", systemImage: "play.fill") }
                        .buttonStyle(BridgeButtonStyle(primary: true)).disabled(!model.canStart).accessibilityIdentifier("start-bridge")
                }
                Spacer(minLength: 0)
                Button { model.openMacApp() } label: { Label("Open Mac App", systemImage: "arrow.up.right") }
                    .buttonStyle(BridgeButtonStyle()).accessibilityIdentifier("open-mac-app")
            }.padding(.top, 5)

            if !snapshot.safeToChange && snapshot.installed && snapshot.canStart != true {
                notice("Controls become available when the current interaction has finished and the service is safe to change.", icon: "lock", color: Palette.secondary)
            } else {
                Text("Open Even Terminal on your phone or glasses to connect.\nThis window shows the Mac service; it does not verify a glasses connection.")
                    .font(.system(size: 11)).foregroundStyle(Palette.secondary).lineSpacing(4)
            }
            HStack(spacing: 5) {
                Image(systemName: "clock").font(.system(size: 9))
                if let date = model.lastRefresh { Text("Updated \(date.formatted(date: .omitted, time: .shortened)) · refreshes automatically") }
                else { Text("Waiting for status") }
            }.font(.system(size: 10)).foregroundStyle(Palette.secondary.opacity(0.75)).padding(.top, 2)
        }
    }

    private func settings(_ snapshot: BridgeSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 19) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .center, spacing: 25) {
                    VStack(alignment: .leading, spacing: 7) {
                        Text("Launch at login").font(.system(size: 14, weight: .semibold))
                        Text("Start the bridge automatically when you sign in to this Mac.").font(.system(size: 12)).foregroundStyle(Palette.secondary).lineSpacing(4)
                    }
                    Spacer(minLength: 0)
                    Toggle("Launch at login", isOn: Binding(get: { snapshot.launchAtLogin }, set: { value in model.perform("set-preferences", preferences: ["launchAtLogin": value]) }))
                        .labelsHidden().toggleStyle(.switch).disabled(!model.canChangePreferences).accessibilityIdentifier("launch-at-login")
                }.padding(23)
                Rectangle().fill(Palette.border).frame(height: 1)
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "moon.zzz").foregroundStyle(Palette.accent).font(.system(size: 18)).padding(.top, 2)
                    Text("You can close or quit this app. The bridge keeps running independently in the background.")
                        .font(.system(size: 12)).foregroundStyle(Palette.secondary).lineSpacing(4)
                }.padding(23)
            }.panel()
            VStack(alignment: .leading, spacing: 14) {
                Text("Your connection").font(.system(size: 14, weight: .semibold))
                Text("Your existing Even Terminal pairing and network configuration stay with the local bridge. Manage the private network in Tailscale.")
                    .font(.system(size: 12)).foregroundStyle(Palette.secondary).lineSpacing(4)
                Button { model.openTailscale() } label: { Label("Open Tailscale", systemImage: "arrow.up.right") }.buttonStyle(BridgeButtonStyle())
            }.padding(23).frame(maxWidth: .infinity, alignment: .leading).panel()
            if snapshot.canChangePreferences != true && snapshot.installed {
                notice("The launch preference is unavailable until the local service can be safely managed.", icon: "lock", color: Palette.secondary)
            }
        }
    }

    private func maintenance(_ snapshot: BridgeSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top, spacing: 20) {
                VStack(alignment: .leading, spacing: 7) {
                    Text("INSTALLED BRIDGE").font(.system(size: 9, weight: .semibold)).tracking(1.2).foregroundStyle(Palette.secondary)
                    Text(version(snapshot.bridgeVersion)).font(.system(size: 25, weight: .medium)).tracking(-0.7)
                }
                Spacer(minLength: 0)
                VStack(alignment: .trailing, spacing: 7) {
                    Text("PREVIOUS VERSION").font(.system(size: 9, weight: .semibold)).tracking(1.2).foregroundStyle(Palette.secondary)
                    Text(version(snapshot.previousVersion)).font(.system(size: 17, weight: .medium)).foregroundStyle(Palette.secondary)
                }
            }.padding(23).panel()
            VStack(alignment: .leading, spacing: 16) {
                Text("Installation check").font(.system(size: 14, weight: .semibold))
                Text("Verify the installed files, Mac compatibility, and service health. This check does not change your installation.")
                    .font(.system(size: 12)).foregroundStyle(Palette.secondary).lineSpacing(4)
                HStack(spacing: 10) {
                    Button { model.perform("diagnose") } label: { Label("Check Installation", systemImage: "checkmark.shield") }
                        .buttonStyle(BridgeButtonStyle(primary: true)).disabled(model.busyAction != nil || model.isRefreshing || model.preview)
                        .accessibilityIdentifier("check-installation")
                    Button { model.revealSupportFolder() } label: { Text("Open Support Folder") }
                        .buttonStyle(BridgeButtonStyle()).disabled(!snapshot.installed)
                }
                if let details = model.diagnostics {
                    DisclosureGroup("Technical details") {
                        ScrollView([.horizontal, .vertical]) {
                            Text(details).font(.system(size: 10, design: .monospaced)).textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                        }.frame(maxHeight: 180).background(Palette.background, in: RoundedRectangle(cornerRadius: 8)).padding(.top, 8)
                    }.font(.system(size: 11)).foregroundStyle(Palette.secondary)
                }
            }.padding(23).frame(maxWidth: .infinity, alignment: .leading).panel()
            HStack(alignment: .center, spacing: 22) {
                VStack(alignment: .leading, spacing: 7) {
                    Text("Restore a previous version").font(.system(size: 13, weight: .semibold))
                    Text(snapshot.canRollback ? "Use your saved version if a recent update causes trouble." : "No restorable version is available right now.")
                        .font(.system(size: 11)).foregroundStyle(Palette.secondary).lineSpacing(4)
                }
                Spacer(minLength: 0)
                Button { confirmsRollback = true } label: { Text("Restore…") }.buttonStyle(BridgeButtonStyle())
                    .disabled(!model.canMutate || !snapshot.canRollback).accessibilityIdentifier("restore-version")
            }.padding(21).panel()
            Text("Updates are installed from a tested release. This app does not download or install new versions automatically.")
                .font(.system(size: 11)).foregroundStyle(Palette.secondary).lineSpacing(4)
        }
    }

    private func connectionCard(title: String, icon: String, value: String, available: Bool) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) { Image(systemName: icon).font(.system(size: 12)); Text(title).font(.system(size: 11, weight: .medium)) }.foregroundStyle(Palette.secondary)
            HStack(spacing: 7) { Circle().fill(available ? Palette.accent : Color.orange).frame(width: 5, height: 5); Text(value).font(.system(size: 13, weight: .medium)) }
        }.frame(maxWidth: .infinity, alignment: .leading).padding(19).panel()
    }

    private func notice(_ text: String, icon: String, color: Color) -> some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: icon).font(.system(size: 12)).padding(.top, 1)
            Text(text).font(.system(size: 11)).lineSpacing(4).fixedSize(horizontal: false, vertical: true)
        }.foregroundStyle(color)
    }

    private func statusColor(_ snapshot: BridgeSnapshot) -> Color { snapshot.isReady ? Palette.accent : snapshot.running ? .orange : Palette.secondary }
    private func version(_ value: String?) -> String { value?.replacingOccurrences(of: "G2 Desktop Bridge ", with: "") ?? "—" }
}

private struct BridgeButtonStyle: ButtonStyle {
    var primary = false
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(size: 11, weight: .semibold))
            .foregroundStyle(primary ? Palette.background : Palette.text)
            .padding(.horizontal, 13).frame(height: 34)
            .background(primary ? Palette.accent : Palette.panel, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(primary ? Color.clear : Palette.border, lineWidth: 1))
            .opacity(isEnabled ? (configuration.isPressed ? 0.7 : 1) : 0.35)
    }
}

private extension View {
    func panel() -> some View {
        background(Palette.panel, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Palette.border, lineWidth: 1))
    }
}
