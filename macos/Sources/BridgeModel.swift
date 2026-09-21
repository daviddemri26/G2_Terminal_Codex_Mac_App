import AppKit
import SwiftUI
import CoreImage.CIFilterBuiltins

@MainActor
final class BridgeModel: ObservableObject {
    @Published private(set) var snapshot: BridgeSnapshot?
    @Published private(set) var isRefreshing = false
    @Published private(set) var busyAction: String?
    @Published private(set) var statusError: String?
    @Published var operationError: String?
    @Published private(set) var notice: String?
    @Published private(set) var diagnostics: String?
    @Published private(set) var lastRefresh: Date?
    @Published var pairingImage: NSImage?
    private var pollTask: Task<Void, Never>?
    let preview: Bool

    init(preview: Bool = false) {
        self.preview = preview
        if preview { snapshot = .preview; lastRefresh = Date() }
    }

    var canMutate: Bool {
        !preview && busyAction == nil && statusError == nil && !isRefreshing
            && snapshot?.installed == true && snapshot?.safeToChange == true
    }

    var canChangePreferences: Bool {
        !preview && busyAction == nil && statusError == nil && !isRefreshing
            && snapshot?.installed == true && snapshot?.canChangePreferences == true
    }

    var canStart: Bool {
        !preview && busyAction == nil && statusError == nil && !isRefreshing
            && snapshot?.installed == true && snapshot?.running == false && snapshot?.canStart == true
    }

    var canChangeFormatting: Bool {
        !preview && busyAction == nil && statusError == nil && !isRefreshing
            && snapshot?.canChangeFormatting == true
    }

    func saveFormatting(_ formatting: TextFormatting) {
        guard canChangeFormatting else { return }
        busyAction = "set-formatting"
        notice = nil
        Task {
            do {
                let input = try JSONEncoder().encode(formatting)
                let result = try await execute("set-formatting", apply: true, input: input, timeout: 15)
                snapshot = try result.snapshot()
                statusError = nil
                lastRefresh = Date()
                notice = "Text settings saved. They apply to the next response or a reopened conversation."
            } catch { operationError = error.localizedDescription }
            busyAction = nil
            await refresh()
        }
    }

    func openGuide() {
        NSWorkspace.shared.open(URL(string: "https://daviddemri26.github.io/G2_Terminal_Codex_Mac_App/")!)
    }

    func showPairing() {
        guard !preview, busyAction == nil, snapshot?.installed == true,
              snapshot?.running == true, snapshot?.networkAvailable == true else { return }
        busyAction = "pair"
        Task {
            defer { busyAction = nil }
            do {
                guard let resources = Bundle.main.resourceURL else { throw ControlFailure.message("The app’s setup files are missing.") }
                let result = try await CommandRunner.run(executable: URL(fileURLWithPath: "/usr/bin/python3"),
                    arguments: [resources.appendingPathComponent("operations/setup.py").path, "pair", "--reveal"], timeout: 15)
                guard result.exitCode == 0 else { throw ControlFailure.message("Pairing is not available yet. Check the bridge and Tailscale connection, then try again.") }
                let pair = try JSONDecoder().decode(PairingDetails.self, from: result.stdout)
                guard let url = URLComponents(string: pair.url), url.scheme == "http", url.host != nil else {
                    throw ControlFailure.message("The local pairing information could not be read.")
                }
                let filter = CIFilter.qrCodeGenerator()
                filter.message = Data(pair.url.utf8)
                filter.correctionLevel = "M"
                guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
                      let cgImage = CIContext().createCGImage(output, from: output.extent) else {
                    throw ControlFailure.message("The pairing code could not be created.")
                }
                pairingImage = NSImage(cgImage: cgImage, size: NSSize(width: 260, height: 260))
            } catch { operationError = "Pairing is not available. Check your installation and private network, then try again." }
        }
    }

    func startObserving() {
        guard pollTask == nil, !preview else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: .seconds(8))
            }
        }
    }

    func refresh() async {
        guard !preview, !isRefreshing, busyAction == nil else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            let result = try await execute("status", timeout: 15)
            snapshot = try result.snapshot()
            statusError = nil
            lastRefresh = Date()
        } catch { statusError = error.localizedDescription }
    }

    func perform(_ action: String, preferences: [String: Bool]? = nil) {
        guard busyAction == nil, !isRefreshing, !preview else { return }
        let readOnly = action == "diagnose"
        let permitted = action == "set-preferences" ? canChangePreferences : action == "start" ? canStart : canMutate
        guard readOnly || permitted else { return }
        if action == "rollback" && snapshot?.canRollback != true { return }
        busyAction = action
        notice = nil
        diagnostics = nil
        Task {
            do {
                let input = try preferences.map { try JSONSerialization.data(withJSONObject: $0) }
                let result = try await execute(action, apply: !readOnly, input: input, timeout: readOnly ? 120 : 300)
                snapshot = try result.snapshot()
                statusError = nil
                lastRefresh = Date()
                if readOnly {
                    diagnostics = result.diagnosticDetails
                    notice = "Installation check finished. Review the current status and details below."
                } else {
                    notice = action == "set-preferences" ? "Your launch preference was saved." : "Request completed. The latest status is shown here."
                }
            } catch { operationError = error.localizedDescription }
            busyAction = nil
            await refresh()
        }
    }

    private func execute(_ command: String, apply: Bool = false, input: Data? = nil, timeout: TimeInterval) async throws -> CommandResult {
        guard let resources = Bundle.main.resourceURL else {
            throw ControlFailure.message("The app’s control files are missing. Reinstall Even Terminal for Codex Mac App.")
        }
        let script = resources.appendingPathComponent("operations/control.py")
        guard FileManager.default.fileExists(atPath: script.path) else {
            throw ControlFailure.message("The app’s control files are missing. Reinstall Even Terminal for Codex Mac App.")
        }
        var arguments = [script.path, command]
        if apply { arguments.append("--apply") }
        return try await CommandRunner.run(executable: URL(fileURLWithPath: "/usr/bin/python3"), arguments: arguments, input: input, timeout: timeout)
    }

    func openMacApp() {
        if let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.openai.codex") {
            NSWorkspace.shared.openApplication(at: app, configuration: NSWorkspace.OpenConfiguration())
        } else {
            operationError = "The Mac app could not be found. Open Codex from its installed location."
        }
    }

    func openTailscale() {
        let options = ["io.tailscale.ipn.macos", "io.tailscale.ipn.macsys"]
        let app = options.compactMap { NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0) }.first
            ?? URL(fileURLWithPath: "/Applications/Tailscale.app")
        guard FileManager.default.fileExists(atPath: app.path) else {
            operationError = "Tailscale could not be found. Open your network app from its installed location."
            return
        }
        NSWorkspace.shared.openApplication(at: app, configuration: NSWorkspace.OpenConfiguration())
    }

    func revealSupportFolder() {
        guard let path = snapshot?.supportPath, !path.isEmpty, FileManager.default.fileExists(atPath: path) else {
            operationError = "The bridge support folder is not available yet."
            return
        }
        NSWorkspace.shared.open(URL(fileURLWithPath: path, isDirectory: true))
    }
}
