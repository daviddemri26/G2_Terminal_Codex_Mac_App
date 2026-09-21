import Foundation

@main
enum ControlTests {
    static func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() { throw ControlFailure.message(message) }
    }

    static func main() async throws {
        let ready = BridgeSnapshot.preview
        try require(ready.isReady, "Preview ready state should be available")
        let formatting = TextFormatting.original
        try require(formatting.showTimestamps && formatting.showProgressUpdates && formatting.paragraphSpacing == "original", "The original rendering must remain the default")
        let formattingRoundTrip = try JSONDecoder().decode(TextFormatting.self, from: JSONEncoder().encode(formatting))
        try require(formattingRoundTrip == formatting, "Saved formatting must follow the controller JSON contract")
        let fixture = """
        {"installed":true,"running":true,"launchAtLogin":true,"bridgeVersion":"0.2.7","previousVersion":null,"state":"starting","message":"Starting","action":"Wait","desktopCompatible":true,"desktopAvailable":true,"networkAvailable":true,"safeToChange":false,"canRollback":false,"supportPath":"","checkedAt":"2026-09-21T12:00:00Z"}
        """
        let starting = try JSONDecoder().decode(BridgeSnapshot.self, from: Data(fixture.utf8))
        try require(!starting.isReady, "A loaded service must not be shown as ready while starting")
        let stopped = fixture.replacingOccurrences(of: "\"running\":true", with: "\"running\":false").replacingOccurrences(of: "\"state\":\"starting\"", with: "\"state\":\"stopped\"")
        let stoppedState = try JSONDecoder().decode(BridgeSnapshot.self, from: Data(stopped.utf8))
        try require(stoppedState.title == "Bridge is stopped", "Stopped label must not claim a ready bridge")
        let pendingStopped = stopped.replacingOccurrences(of: "\"state\":\"stopped\"", with: "\"state\":\"delivery_pending\",\"canStart\":true")
        let pendingState = try JSONDecoder().decode(BridgeSnapshot.self, from: Data(pendingStopped.utf8))
        try require(pendingState.canStart == true && !pendingState.safeToChange, "Starting the same stopped release must stay distinct from unsafe lifecycle changes")

        do {
            _ = try CommandResult(stdout: Data("{\"ok\":false,\"error\":\"An interaction is active.\"}".utf8), stderr: "", exitCode: 1).snapshot()
            throw ControlFailure.message("Expected a rejected controller action")
        } catch {
            try require(error.localizedDescription == "An interaction is active.", "Preserve the controller's safe error message")
        }
        do {
            _ = try CommandResult(stdout: Data(), stderr: "PRIVATE-STDERR", exitCode: 2).snapshot()
            throw ControlFailure.message("Expected subprocess failure")
        } catch {
            try require(error.localizedDescription.contains("code 2") && !error.localizedDescription.contains("PRIVATE-STDERR"), "Do not display raw stderr in user alerts")
        }

        let python = URL(fileURLWithPath: "/usr/bin/python3")
        let result = try await CommandRunner.run(executable: python,
            arguments: ["-c", "import json,sys; data=json.load(sys.stdin); print(json.dumps(data))"],
            input: Data(fixture.utf8), timeout: 5)
        let roundTrip = try result.snapshot()
        try require(roundTrip.state == "starting", "JSON stdin must round-trip without shell escaping")
        let large = try await CommandRunner.run(executable: python, arguments: ["-c", "print('x'*200000)"], timeout: 5)
        try require(large.stdout.count == 200001 && large.exitCode == 0, "Large diagnostics must not deadlock")
        let before = Date()
        do {
            _ = try await CommandRunner.run(executable: python, arguments: ["-c", "import time; time.sleep(10)"], timeout: 0.2)
            throw ControlFailure.message("Expected a bounded process timeout")
        } catch {
            try require(error.localizedDescription.contains("uncertain"), "Timeout must describe the uncertain outcome")
            try require(Date().timeIntervalSince(before) < 4, "Timeout must terminate the request promptly")
        }
        print("Passed: readiness, stopped state, safe errors, JSON input, large output, bounded timeout.")
    }
}
