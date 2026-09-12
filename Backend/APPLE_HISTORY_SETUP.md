# NutriScan 交易历史核验接入

2026-09-12：新增 apple-purchase-history.mjs，使用官方 Apple Server Library 的 V2 完整交易历史接口，不过滤已退款交易。逐页验签并核对 App、环境及 appTransactionId；缺价、分页不全、签名失败、查询失败不放行资格。35 项后端测试通过。

模块尚未接入自动绑定入口，尚未启用佣金，未部署此次新增文件。它返回的 eligible 仅表示生产环境交易历史未发现付费，不代表身份、7 天窗口和绑定规则均通过；调用方仍须分别验证。

服务端配置项：NUTRISCAN_APPLE_IAP_PRIVATE_KEY、NUTRISCAN_APPLE_IAP_KEY_ID、NUTRISCAN_APPLE_IAP_ISSUER_ID。私钥不可进入源码、App 或网页，也不可输出到日志。

Apple 后台已创建 Partner Backend Verification，Key ID YGM23Q3KN6，Issuer ID c9a94d5f-8fb0-4509-b571-d08e93426ab8。页面显示已下载，但本机文件未找到，尚未配置 Render，未用于任何 API 请求。需要取回下载文件或由用户批准撤销未使用密钥并重新生成、确认保存。

scripts/apple-notification-test.mjs 支持 request/status，限定 NutriScan，按生产/沙盒隔离结果文件。请求前预留文件避免误重复；状态查询会验证 Apple 签名后才报告送达。只打印状态与通知 ID，不打印私钥、JWT 或测试请求 token。

用法：node scripts/apple-notification-test.mjs request|status Production|Sandbox 私钥文件 KeyID IssuerID 结果文件

依据：[Apple 完整交易历史接口](https://developer.apple.com/documentation/appstoreserverapi/get-transaction-history)、[分页规则](https://developer.apple.com/documentation/appstoreserverapi/hasmore)。
