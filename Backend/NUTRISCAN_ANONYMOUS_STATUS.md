# NutriScan 匿名安装身份：开发分支

客户端以 SecRandomCopyBytes 生成 256 位随机凭证，按 Apple appTransactionID 与环境隔离，存入不可同步、仅限本机的 Keychain。读取失败不覆盖旧凭证。私密值不进入本地 JSON outbox；仅通过 HTTPS 请求头送到现有产品后台。

后端在 Apple App 凭证验签及历史查询完成后接受注册。按产品、环境、App 交易标识固定一份身份，只保存凭证 SHA-256 摘要；跨重启重复注册返回同一 customer_id，不同凭证不能替换，并发写入串行化。无凭证的旧版请求保持兼容。

状态限制：仅证明持有该安装私密凭证，不能单凭 Apple App 历史证明当前设备归属。所有新身份 identity_verified=false、registered_at=null，first_observed_at 仅为后台首次见到记录的时间，不能冒充 App 真实首次使用。因此自动绑定仍被资格校验拒绝。下一步必须补设备证明及历史首次使用迁移，之后才可启用绑定入口；不得把这份身份注册完成解释为推广归因完成。

验证：44 项后端测试通过；NutriScan 完整模拟器编译通过。本轮未发布 App 或部署后端。此前线上仍为 v7。
