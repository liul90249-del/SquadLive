# NutriScan 匿名安装身份：开发分支

客户端以 SecRandomCopyBytes 生成 256 位随机凭证，按 Apple appTransactionID 与环境隔离，存入不可同步、仅限本机的 Keychain。读取失败不覆盖旧凭证。私密值不进入本地 JSON outbox；仅通过 HTTPS 请求头送到现有产品后台。

后端在 Apple App 凭证验签及历史查询完成后接受注册。按产品、环境、App 交易标识固定一份身份，只保存凭证 SHA-256 摘要；跨重启重复注册返回同一 customer_id，不同凭证不能替换，并发写入串行化。无凭证的旧版请求保持兼容。

状态限制：仅证明持有该安装私密凭证，不能单凭 Apple App 历史证明当前设备归属。所有新身份 identity_verified=false、registered_at=null，first_observed_at 仅为后台首次见到记录的时间，不能冒充 App 真实首次使用。因此自动绑定仍被资格校验拒绝。下一步必须补设备证明及历史首次使用迁移，之后才可启用绑定入口；不得把这份身份注册完成解释为推广归因完成。

验证：44 项后端测试通过；NutriScan 完整模拟器编译通过。本轮未发布 App 或部署后端。此前线上仍为 v7。

## App Attest 设备证明开发

增加 /v1/partners/nutriscan/device：仅在安装私密凭证鉴权后发放 120 秒随机挑战，按用途隔离。生产 App Attest 密钥验签并验证证书期限，禁止 development 证明；同一密钥不能跨安装或环境挪用。挑战消费及签名计数持久化，过期和重放拒绝。首次 attestation 回包丢失允许同一证明幂等重试。

客户端在签名 App 历史与身份注册成功后调用 DeviceCheck 框架；设备密钥不导出，公开的 keyId/待提交证明保存在排除备份的文件中。恢复原始 HealthKit entitlements 并增加 production App Attest entitlement。未支持 App Attest 的模拟器不伪装为验证通过。

48 项后端测试通过（含真实 EC 签名的 assertion 验证），客户端模拟器编译通过；npm audit 生产依赖报告 0 已知漏洞。真实 Apple attestation、真机签名及安装尚未验收，首次使用资格、绑定及佣金仍未启用。device-check 证明不应作为其他请求的通用授权，实际绑定必须另签包含邀请码的请求。

依赖固定 node-app-attest 1.0.1 与 cbor 10.0.12；自行补充证书日期及严格 assertion 格式校验。依据：[Apple 服务端验证](https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server)、[客户端完整性](https://developer.apple.com/documentation/devicecheck/establishing-your-app-s-integrity)。
