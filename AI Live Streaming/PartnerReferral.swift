import SwiftUI
#if os(iOS)
import Security
#endif

struct PartnerReferralConfiguration {
    let appName: String
    let product: String
    let storeURLString: String

    static let current = PartnerReferralConfiguration(
        appName: "SquadLive",
        product: "squadlive",
        storeURLString: "https://apps.apple.com/app/id6792211208"
    )

    var storeURL: URL { URL(string: storeURLString)! }
    var storageKey: String { "partner.referral.\(product).code" }

    func referralURL(for code: String) -> URL {
        URL(string: "https://partner.cleann.top/r/\(code)?product=\(product)")!
    }
}

enum PartnerReferralLink {
    static let changed = Notification.Name("PartnerReferralCodeChanged")

    @discardableResult
    static func handle(_ url: URL, config: PartnerReferralConfiguration = .current) -> Bool {
        guard url.host?.lowercased() == "partner.cleann.top" else { return false }
        let parts = url.pathComponents.filter { $0 != "/" }
        guard parts.count >= 2, parts[0] == "r" else { return false }
        let code = parts[1].uppercased()
        guard isValidFormat(code) else { return false }
        if let product = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "product" })?.value,
           product != config.product {
            return false
        }

        Task {
            guard await isAvailable(code, config: config) else { return }
            await MainActor.run {
                guard saveIfUnbound(code, config: config) else { return }
                NotificationCenter.default.post(name: changed, object: config.product)
            }
        }
        return true
    }

    static func savedCode(config: PartnerReferralConfiguration = .current) -> String {
        UserDefaults.standard.string(forKey: config.storageKey) ?? ""
    }

    static func isValidFormat(_ code: String) -> Bool {
        code.range(of: "^(PC|PS)[A-F0-9]{12}$", options: .regularExpression) != nil
    }

    static func isAvailable(_ code: String, config: PartnerReferralConfiguration) async -> Bool {
        if config.product == "squadlive" {
            return await SquadLivePartnerAttributionClient.bind(code: code)
        }
        var components = URLComponents(string: "https://partner.cleann.top/api/code")!
        components.queryItems = [
            URLQueryItem(name: "product", value: config.product),
            URLQueryItem(name: "code", value: code)
        ]
        var request = URLRequest(url: components.url!)
        request.timeoutInterval = 15
        guard let (_, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode) else { return false }
        return true
    }

    @discardableResult
    static func saveIfUnbound(_ code: String, config: PartnerReferralConfiguration) -> Bool {
        let existing = savedCode(config: config)
        guard existing.isEmpty || existing == code else { return false }
        UserDefaults.standard.set(code, forKey: config.storageKey)
        return true
    }
}

enum SquadLivePartnerAttributionClient {
    private static let backend = URL(string: "https://squadlive.onrender.com")!
    private static let accountTokenKey = "squadlive.partner-account-token"
    private static let credentialAccount = "partner-installation-credential"

    static var purchaseAccountToken: UUID? {
        UserDefaults.standard.string(forKey: accountTokenKey).flatMap(UUID.init(uuidString:))
    }

    static func bootstrap() async {
        _ = await sessionToken()
    }

    static func bind(code: String) async -> Bool {
        guard PartnerReferralLink.isValidFormat(code), let token = await sessionToken() else { return false }
        guard await attributionRequest(token: token, body: ["action": "preview", "code": code]) else { return false }
        return await attributionRequest(token: token, body: ["action": "bind", "code": code, "confirmed": true])
    }

    private static func sessionToken() async -> String? {
        var payload: [String: Any] = ["deviceId": SquadLiveDeviceIdentity.value]
        if let credential = credential {
            payload["credential"] = credential
        }
        var request = URLRequest(url: backend.appendingPathComponent("v1/partner/session"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 15
        request.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = object["token"] as? String,
              let accountToken = object["account_token"] as? String,
              UUID(uuidString: accountToken) != nil else { return nil }
        saveCredential(token)
        UserDefaults.standard.set(accountToken, forKey: accountTokenKey)
        return token
    }

    private static func attributionRequest(token: String, body: [String: Any]) async -> Bool {
        var request = URLRequest(url: backend.appendingPathComponent("v1/partner/attribution"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 20
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        guard let (_, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse else { return false }
        return (200..<300).contains(http.statusCode)
    }

    private static var credential: String? {
#if os(iOS)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Bundle.main.bundleIdentifier ?? "SquadLive",
            kSecAttrAccount as String: credentialAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
#else
        return UserDefaults.standard.string(forKey: credentialAccount)
#endif
    }

    private static func saveCredential(_ value: String) {
#if os(iOS)
        let service = Bundle.main.bundleIdentifier ?? "SquadLive"
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: credentialAccount
        ]
        let data = Data(value.utf8)
        if SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary) == errSecItemNotFound {
            var insert = query
            insert[kSecValueData as String] = data
            SecItemAdd(insert as CFDictionary, nil)
        }
#else
        UserDefaults.standard.set(value, forKey: credentialAccount)
#endif
    }
}

struct PartnerReferralCenterView: View {
    let config: PartnerReferralConfiguration
    @Environment(\.dismiss) private var dismiss
    @State private var code: String
    @State private var status = ""
    @State private var isChecking = false

    init(config: PartnerReferralConfiguration = .current) {
        self.config = config
        _code = State(initialValue: PartnerReferralLink.savedCode(config: config))
    }

    private var isChinese: Bool {
        Locale.preferredLanguages.first?.hasPrefix("zh") == true
    }

    private var savedCode: String {
        PartnerReferralLink.savedCode(config: config)
    }

    private var shareURL: URL {
        PartnerReferralLink.isValidFormat(savedCode) ? config.referralURL(for: savedCode) : config.storeURL
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ShareLink(
                        item: shareURL,
                        subject: Text(config.appName),
                        message: Text(isChinese
                            ? "推荐你试试 \(config.appName)。"
                            : "I think you might like \(config.appName).")
                    ) {
                        Label(isChinese ? "分享 App" : "Share App", systemImage: "square.and.arrow.up")
                    }
                } footer: {
                    Text(PartnerReferralLink.isValidFormat(savedCode)
                         ? (isChinese ? "分享链接会携带已保存的邀请码；已安装时自动识别，未安装时可在安装后手动输入。" : "The link includes your saved invite code. Installed apps recognize it automatically; after a new install, it can be entered manually.")
                         : (isChinese ? "尚未绑定邀请码，将分享官方 App Store 地址。" : "No invite code is saved, so the official App Store address will be shared."))
                }

                Section {
                    TextField("PC… / PS…", text: $code)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .font(.system(.body, design: .monospaced))
                        .onChange(of: code) { value in
                            code = String(value.uppercased().filter { $0.isLetter || $0.isNumber }.prefix(14))
                            status = ""
                        }

                    Button {
                        verifyAndSave()
                    } label: {
                        HStack {
                            if isChecking { ProgressView() }
                            Text(isChecking
                                 ? (isChinese ? "正在核验…" : "Checking…")
                                 : (isChinese ? "核验并保存" : "Verify and Save"))
                        }
                    }
                    .disabled(isChecking || !PartnerReferralLink.isValidFormat(code))

                    if !status.isEmpty {
                        Text(status)
                            .font(.footnote)
                            .foregroundStyle(status.hasPrefix("✓") ? .green : .red)
                    }
                } header: {
                    Text(isChinese ? "输入邀请码" : "Enter Invite Code")
                } footer: {
                    Text(isChinese
                         ? "邀请码首次绑定后不可替换。购买过的账号不能补填邀请码。"
                         : "An invite code cannot be replaced after its first verified binding. Existing purchasers cannot add one retroactively.")
                }
            }
            .navigationTitle(isChinese ? "分享与邀请码" : "Share & Invite Code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(isChinese ? "完成" : "Done") { dismiss() }
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: PartnerReferralLink.changed)) { note in
                guard note.object as? String == config.product else { return }
                code = PartnerReferralLink.savedCode(config: config)
                status = isChinese ? "✓ 已从分享链接保存邀请码，将在首次激活时完成归因" : "✓ Invite code saved from the shared URL for first-activation attribution"
            }
        }
    }

    private func verifyAndSave() {
        let normalized = code.uppercased()
        guard PartnerReferralLink.isValidFormat(normalized) else {
            status = isChinese ? "邀请码格式不正确" : "Invalid invite code format"
            return
        }
        if !savedCode.isEmpty && savedCode != normalized {
            status = isChinese ? "此设备已经绑定其他邀请码" : "This device is already linked to another invite code"
            return
        }
        isChecking = true
        status = ""
        Task {
            let available = await PartnerReferralLink.isAvailable(normalized, config: config)
            await MainActor.run {
                if available && PartnerReferralLink.saveIfUnbound(normalized, config: config) {
                    code = normalized
                    status = isChinese ? "✓ 邀请码有效并已保存，将在首次激活时完成归因" : "✓ Invite code verified and saved for first-activation attribution"
                } else {
                    status = isChinese ? "暂时无法核验，请检查网络或邀请码后重试" : "Could not verify the code. Check the code and your connection."
                }
                isChecking = false
            }
        }
    }
}
