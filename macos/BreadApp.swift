import AppKit
import SwiftUI
import WebKit

private let readerURL = URL(string: "http://127.0.0.1:4173/")!
private let applicationSupportName = "bread"
#if !PUBLIC_RELEASE
private let legacyApplicationSupportName = "Read Like 2000"
#endif

@MainActor
final class ReaderRuntime: ObservableObject {
    @Published var isReady = false
    @Published var errorMessage: String?

    private var serverProcess: Process?

    init() {
        Task {
            await start()
        }
    }

    func stop() {
        guard let serverProcess, serverProcess.isRunning else { return }
        serverProcess.terminate()
    }

    private func start() async {
        if await readerIsAvailable() {
            isReady = true
            return
        }

        do {
            let readerDirectory = try installReaderFiles()
            let process = Process()
            process.executableURL = Bundle.main.resourceURL?.appendingPathComponent("node")
            process.arguments = ["server.js"]
            process.currentDirectoryURL = readerDirectory
            process.environment = ProcessInfo.processInfo.environment.merging(["PORT": "4173"]) { _, new in new }

            let output = Pipe()
            process.standardOutput = output
            process.standardError = output
            output.fileHandleForReading.readabilityHandler = { handle in
                _ = handle.availableData
            }

            try process.run()
            serverProcess = process

            for _ in 0..<50 {
                try await Task.sleep(for: .milliseconds(160))

                if await readerIsAvailable() {
                    isReady = true
                    return
                }
            }

            errorMessage = "Не получилось запустить локальную читалку."
        } catch {
            errorMessage = "Не получилось запустить локальную читалку."
        }
    }

    private func readerIsAvailable() async -> Bool {
        var request = URLRequest(url: readerURL.appendingPathComponent("api/config"))
        request.timeoutInterval = 0.8

        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            return (response as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }

    private func installReaderFiles() throws -> URL {
        let fileManager = FileManager.default
        let applicationSupportDirectory = try fileManager.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let supportRoot = applicationSupportDirectory.appendingPathComponent(applicationSupportName, isDirectory: true)
        let readerDirectory = supportRoot.appendingPathComponent("reader", isDirectory: true)
        let bundledReader = Bundle.main.resourceURL!.appendingPathComponent("reader", isDirectory: true)

#if !PUBLIC_RELEASE
        let legacySupportRoot = applicationSupportDirectory.appendingPathComponent(legacyApplicationSupportName, isDirectory: true)

        if !fileManager.fileExists(atPath: supportRoot.path),
           fileManager.fileExists(atPath: legacySupportRoot.path) {
            try fileManager.copyItem(at: legacySupportRoot, to: supportRoot)
        }
#endif

        try fileManager.createDirectory(at: readerDirectory, withIntermediateDirectories: true)

        try replaceItem(
            at: readerDirectory.appendingPathComponent("server.js"),
            with: bundledReader.appendingPathComponent("server.js")
        )
        try replaceItem(
            at: readerDirectory.appendingPathComponent("public", isDirectory: true),
            with: bundledReader.appendingPathComponent("public", isDirectory: true)
        )

        let dataDirectory = readerDirectory.appendingPathComponent("data", isDirectory: true)
        try fileManager.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
        let installedSources = dataDirectory.appendingPathComponent("sources.json")

        if !fileManager.fileExists(atPath: installedSources.path) {
            try fileManager.copyItem(
                at: bundledReader.appendingPathComponent("data/sources.json"),
                to: installedSources
            )
        }

        return readerDirectory
    }

    private func replaceItem(at destination: URL, with source: URL) throws {
        let fileManager = FileManager.default

        if fileManager.fileExists(atPath: destination.path) {
            try fileManager.removeItem(at: destination)
        }

        try fileManager.copyItem(at: source, to: destination)
    }
}

struct ReaderWebView: NSViewRepresentable {
    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.userContentController.addUserScript(
            WKUserScript(
                source: "window.READ_LIKE_NATIVE = true;",
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        )

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsMagnification = true
        webView.setValue(false, forKey: "drawsBackground")
        webView.load(URLRequest(url: readerURL))
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            if navigationAction.request.url?.scheme == "readlike" {
                if navigationAction.request.url?.host == "fullscreen" {
                    DispatchQueue.main.async {
                        webView.window?.toggleFullScreen(nil)
                    }
                }

                decisionHandler(.cancel)
                return
            }

            guard
                navigationAction.navigationType == .linkActivated,
                let url = navigationAction.request.url,
                !["127.0.0.1", "localhost"].contains(url.host ?? "")
            else {
                decisionHandler(.allow)
                return
            }

            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        }

        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if let url = navigationAction.request.url {
                NSWorkspace.shared.open(url)
            }

            return nil
        }
    }
}

struct ReaderRootView: View {
    @ObservedObject var runtime: ReaderRuntime

    var body: some View {
        Group {
            if runtime.isReady {
                ReaderWebView()
            } else {
                ZStack {
                    Color(nsColor: .textBackgroundColor)
                    Text(runtime.errorMessage ?? "Открываю библиотеку")
                        .font(.system(size: 15))
                        .foregroundStyle(.secondary)
                }
            }
        }
        .frame(minWidth: 760, minHeight: 560)
        .onAppear {
            DispatchQueue.main.async {
                guard let window = NSApp.windows.first else { return }
                window.title = "bread"
                window.titleVisibility = .visible
                window.titlebarAppearsTransparent = false
                window.styleMask.remove(.fullSizeContentView)
                window.isMovable = true
                window.isRestorable = false
                window.collectionBehavior.insert(.fullScreenPrimary)
                window.standardWindowButton(.closeButton)?.isHidden = false
                window.standardWindowButton(.miniaturizeButton)?.isHidden = false
                window.standardWindowButton(.zoomButton)?.isHidden = false
                window.setContentSize(NSSize(width: 1100, height: 632))
                window.center()

                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                    window.setContentSize(NSSize(width: 1100, height: 632))
                    window.center()
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in
            runtime.stop()
        }
    }
}

@main
struct BreadApp: App {
    @StateObject private var runtime = ReaderRuntime()

    var body: some Scene {
        WindowGroup("bread") {
            ReaderRootView(runtime: runtime)
        }
        .defaultSize(width: 1100, height: 632)
        .commands {
            CommandGroup(replacing: .newItem) {}
        }
    }
}
