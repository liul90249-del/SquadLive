# NutriScan 交易历史核验接入

2026-09-12：新增 apple-purchase-history.mjs，使用官方 Apple Server Library 的 V2 完整交易历史接口，不过滤已退款交易。逐页验签并核对 App、环境及 appTransactionId；缺价、分页不全、签名失败、查询失败不放行资格。35 项后端测试通过。

模块尚未接入自动绑定入口，尚未启用佣金，未部署此次新增文件。它返回的 eligible 仅表示生产环境交易历史未发现付费，不代表身份、7 天窗口和绑定规则均通过；调用方仍须分别验证。

服务端配置项：NUTRISCAN_APPLE_IAP_PRIVATE_KEY、NUTRISCAN_APPLE_IAP_KEY_ID、NUTRISCAN_APPLE_IAP_ISSUER_ID。私钥不可进入源码、App 或网页，也不可输出到日志。

Apple 后台此前创建 Partner Backend Verification，Key ID YGM23Q3KN6，Issuer ID c9a94d5f-8fb0-4509-b571-d08e93426ab8。下载文件未找到，该密钥未配置 Render、未用于任何 API 请求。用户批准后已撤销，页面确认有效 0、已撤销 1。替代密钥 Partner Backend Verified（Key ID 2SKV9H8RXZ）已生成并确认保存于本机 Downloads。生产与沙盒 Apple TEST 通知均已由 Apple API 确认 SUCCESS。用户随后明确授权将该私钥保存到 Render 服务 srv-d9hji33eo5us73eausdg。NUTRISCAN_APPLE_IAP_PRIVATE_KEY、NUTRISCAN_APPLE_IAP_KEY_ID、NUTRISCAN_APPLE_IAP_ISSUER_ID 已提交保存，触发部署 dep-daij6pfqj5pc73abbuug。

scripts/apple-notification-test.mjs 支持 request/status，限定 NutriScan，按生产/沙盒隔离结果文件。请求前预留文件避免误重复；状态查询会验证 Apple 签名后才报告送达。只打印状态与通知 ID，不打印私钥、JWT 或测试请求 token。

用法：node scripts/apple-notification-test.mjs request|status Production|Sandbox 私钥文件 KeyID IssuerID 结果文件

依据：[Apple 完整交易历史接口](https://developer.apple.com/documentation/appstoreserverapi/get-transaction-history)、[分页规则](https://developer.apple.com/documentation/appstoreserverapi/hasmore)。


## 资格校验接线（v7）

App 历史凭证接口现在在验签后调用 Apple 完整交易历史查询，并持久保存结果。查询失败不返回成功确认，客户端保留队列等待重试；已验证为付费的历史不能被后续空结果重置。两个并发名额覆盖完整处理过程，避免验签结束即提前释放。

NutriScan 绑定引擎新增必需的资格检查回调，在建立远程归属前后核验；缺少回调、未返回 verified:true、历史查询失败及竞态均拒绝或标记人工复核。新增 nutriscan-eligibility.mjs 校验可信身份、不可变首次使用日期及 7 天限制，不使用 App 获取日期代替首次使用。

41 项后端测试通过。该阶段尚未创建 NutriScan 的匿名身份服务及 HTTP 绑定入口；资格模块不能自行证明身份。自动绑定、佣金回传、客户端发布和真实交易验收继续保持未完成。当前佣金仍关闭。
