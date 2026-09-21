import Foundation
import Darwin

struct BridgeSnapshot: Decodable, Sendable {
    let installed: Bool
    let running: Bool
    let launchAtLogin: Bool
    let bridgeVersion: String?
    let previousVersion: String?
    let state: String
    let message: String
    let action: String
    let desktopCompatible: Bool
    let desktopAvailable: Bool
    let networkAvailable: Bool
    let safeToChange: Bool
    let canStart: Bool?
    let canChangePreferences: Bool?
    let canRollback: Bool
    let supportPath: String
    let checkedAt: String
    let ok: Bool?
    let error: String?

    var isReady: Bool {
        installed && running && desktopCompatible && desktopAvailable && networkAvailable
            && state == "ready"
    }

    var title: String {
        if !installed { return "Let’s set up your bridge" }
        switch state {
        case "busy": return "Bridge is in use"
        case "delivery_pending": return "Finishing an interaction"
        case "starting": return "Bridge is starting"
        case "reconnecting", "reconnect_pending": return "Reconnecting to your Mac"
        case "restart_pending": return "Waiting to restart"
        case "invalid_installation": return "Installation needs attention"
        case "unreachable": return "Bridge is not responding"
        case "unmanaged_service", "unexpected_service", "port_in_use": return "Service needs attention"
        case "update_required", "desktop_update_required": return "Compatibility needs attention"
        default: break
        }
        if !running { return "Bridge is stopped" }
        if isReady { return "Bridge is ready" }
        if !desktopCompatible { return "Compatibility needs attention" }
        if !desktopAvailable { return "Waiting for the Mac app" }
        if !networkAvailable { return "Waiting for the network" }
        return "Bridge needs attention"
    }

    var serviceLabel: String { running ? "Running" : "Stopped" }

    static var preview: BridgeSnapshot {
        try! JSONDecoder().decode(BridgeSnapshot.self, from: Data("""
        {"installed":true,"running":true,"launchAtLogin":true,"bridgeVersion":"0.2.7","previousVersion":"0.2.6","state":"ready","message":"Your Mac connection is available. Open Even Terminal on your phone or glasses to continue.","action":"No action needed.","desktopCompatible":true,"desktopAvailable":true,"networkAvailable":true,"safeToChange":true,"canChangePreferences":true,"canRollback":true,"supportPath":"","checkedAt":"2026-09-21T12:00:00Z"}
        """.utf8))
    }
}

struct CommandResult: Sendable {
    let stdout: Data
    let stderr: String
    let exitCode: Int32

    func snapshot() throws -> BridgeSnapshot {
        // An error response may only contain {ok:false,error:...}, so inspect it
        // before decoding a complete snapshot.
        if let object = try? JSONSerialization.jsonObject(with: stdout) as? [String: Any],
           let message = object["error"] as? String,
           exitCode != 0 || object["ok"] as? Bool == false {
            throw ControlFailure.message(message)
        }
        guard exitCode == 0 else {
            // Raw process output can contain private paths. Keep it out of alerts.
            throw ControlFailure.message("The bridge could not complete this request (code \(exitCode)). Check the installation, then try again.")
        }
        do { return try JSONDecoder().decode(BridgeSnapshot.self, from: stdout) }
        catch { throw ControlFailure.message("The bridge returned an unreadable status. Check that this app and its control files belong to the same version.") }
    }

    var diagnosticDetails: String? {
        guard let object = try? JSONSerialization.jsonObject(with: stdout) as? [String: Any],
              let diagnostics = object["diagnostics"],
              JSONSerialization.isValidJSONObject(diagnostics),
              let data = try? JSONSerialization.data(withJSONObject: diagnostics, options: [.prettyPrinted, .sortedKeys]),
              let value = String(data: data, encoding: .utf8) else { return nil }
        return value
    }
}

enum ControlFailure: LocalizedError {
    case message(String)
    var errorDescription: String? {
        switch self { case .message(let value): return value }
    }
}

enum CommandRunner {
    /// Runs outside the main actor. Files prevent a verbose diagnostic response
    /// from filling a pipe and deadlocking the subprocess.
    static func run(executable: URL, arguments: [String], input: Data? = nil, timeout: TimeInterval) async throws -> CommandResult {
        try await Task.detached(priority: .utility) {
            try runBlocking(executable: executable, arguments: arguments, input: input, timeout: timeout)
        }.value
    }

    private static func runBlocking(executable: URL, arguments: [String], input: Data?, timeout: TimeInterval) throws -> CommandResult {
            let manager = FileManager.default
            let directory = manager.temporaryDirectory.appendingPathComponent("g2-bridge-control-" + UUID().uuidString, isDirectory: true)
            try manager.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            defer { try? manager.removeItem(at: directory) }
            let outputURL = directory.appendingPathComponent("stdout")
            let errorURL = directory.appendingPathComponent("stderr")
            manager.createFile(atPath: outputURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
            manager.createFile(atPath: errorURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
            let output = try FileHandle(forWritingTo: outputURL)
            let errors = try FileHandle(forWritingTo: errorURL)
            defer { try? output.close(); try? errors.close() }
            let process = Process()
            process.executableURL = executable
            process.arguments = arguments
            process.standardOutput = output
            process.standardError = errors
            let inherited = ProcessInfo.processInfo.environment
            var environment = inherited.filter { ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"].contains($0.key) }
            environment["PYTHONDONTWRITEBYTECODE"] = "1"
            environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
            process.environment = environment
            let inputPipe = Pipe()
            process.standardInput = inputPipe
            do { try process.run() }
            catch { throw ControlFailure.message("The local bridge controller could not be opened. Reinstall G2 Bridge and verify that Python 3 is available.") }
            if let input { try? inputPipe.fileHandleForWriting.write(contentsOf: input) }
            try? inputPipe.fileHandleForWriting.close()
            let deadline = Date().addingTimeInterval(timeout)
            while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.08) }
            if process.isRunning {
                process.terminate()
                let terminateDeadline = Date().addingTimeInterval(2)
                while process.isRunning && Date() < terminateDeadline { Thread.sleep(forTimeInterval: 0.05) }
                if process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) }
                process.waitUntilExit()
                throw ControlFailure.message("This request took too long. Its result is uncertain; refresh the status before trying again.")
            }
            process.waitUntilExit()
            return CommandResult(stdout: try Data(contentsOf: outputURL),
                                 stderr: (try? String(contentsOf: errorURL, encoding: .utf8)) ?? "",
                                 exitCode: process.terminationStatus)
    }
}
