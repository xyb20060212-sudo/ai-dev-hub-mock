# AI Dev Hub Mock MCP

一个用假数据演示 ChatGPT 网页如何调用本地 MCP 工具的最小服务。服务使用 Node.js 内置模块和 stdio，支持 MCP `2024-11-05`。Windows x64 上已验证官方 Secure MCP Tunnel 能调用 `hub_get_capabilities` 并收到 `simulated: true`。

## 工具

- `hub_list_projects` 列出固定的示例项目。
- `hub_get_project_status` 返回指定示例项目的固定状态。可用 ID 为 `mock-app`、`mock-web`、`mock-otp` 和 `mock-cash`。
- `hub_get_capabilities` 返回协议版本、只读模式和模拟状态。

三个工具只返回源码中的假数据。服务通过 stdin 接收 JSON-RPC，每行一条消息，并通过 stdout 返回协议响应。单条请求上限为 8 KiB。同一进程可顺序握手，演示范围为单个 stdio 子进程的顺序会话。

## 本地验证

1. 克隆本仓库，在仓库根目录打开 PowerShell。
2. 安装 Node.js。已验证版本为 Windows x64 的 **24.22.0**。项目没有第三方依赖。
3. 运行离线测试。

```powershell
node --test tests/handlers.test.mjs tests/stdio.test.mjs
```

也可以用一个短会话验证握手、发现和调用。最后一条结果的 `content[0].text` 是 JSON 字符串，其中 `simulated` 应为 `true`。

```powershell
@'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"local-demo","version":"1.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"hub_get_capabilities","arguments":{}}}
'@ | node src/stdio-server.mjs
```

## 在 ChatGPT 网页中试用

使用自己的 OpenAI Platform 组织和 ChatGPT 工作区。账号与工作区需要有添加自定义 MCP 服务的权限。

1. 在 Platform 创建一条 Secure MCP Tunnel，关联你要使用的 ChatGPT 工作区。创建需要 `Tunnels Read + Manage`。
2. 准备一把受限运行密钥，权限为 `Tunnels Read + Use`。将密钥留在本机。
3. 从 OpenAI 官方发布页下载适合你的平台的 `tunnel-client`，按发布页校验压缩包摘要并解压。已验证 Windows x64 **v0.0.21**。
4. 复制 [`tunnel.example.yaml`](tunnel.example.yaml) 为 `tunnel.local.yaml`，填入你自己的 Tunnel ID、组织 ID、Node.js 和服务文件的绝对路径。只有本机网络需要代理时，才启用配置中的代理选项。
5. 在仓库根目录新开一个 PowerShell 窗口。把下面的客户端路径改成你实际的解压位置，再运行。密钥通过隐藏提示输入，进程退出时会清除当前会话中的密钥变量。

```powershell
if (Test-Path Env:CONTROL_PLANE_API_KEY) {
    throw '请使用尚未设置运行密钥的新 PowerShell 会话。'
}
$client = 'C:\Tools\tunnel-client\tunnel-client.exe'
$profile = (Resolve-Path -LiteralPath '.\tunnel.local.yaml').Path
$key = Read-Host 'Tunnel 运行密钥' -AsSecureString
$keyBuffer = [IntPtr]::Zero
try {
    $keyBuffer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($key)
    $env:CONTROL_PLANE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyBuffer)
    & $client run --profile-file $profile --log.http-raw-unsafe=false
} finally {
    Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
    if ($keyBuffer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyBuffer)
    }
    $key.Dispose()
}
```

6. 客户端开始轮询后，在 ChatGPT 的 **插件 → 添加自定义 MCP 服务器**中选择 **隧道**，绑定你刚创建的 Tunnel。本演示的 MCP 服务使用 **无需身份验证**，Tunnel 的访问仍由组织和工作区控制。
7. 连接后，在空白对话中选择该插件，发出请求「请仅调用一次 `hub_get_capabilities`，参数为 `{}`，展示回执中的 `simulated` 字段。」ChatGPT 的工具回执应显示 `simulated: true`。
8. 试用结束后，在客户端所在的终端按 `Ctrl+C`。模板中的健康检查地址是 `127.0.0.1:18786`，可在试用期间于本机查看 `/readyz` 和 `/health/control-plane`。

[官方客户端发布页](https://github.com/openai/tunnel-client/releases/tag/v0.0.21) · [Secure MCP Tunnel 指南](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) · [ChatGPT 自定义 MCP 指南](https://developers.openai.com/api/docs/guides/custom-mcp-server)

## 许可证

本仓库源码采用 [MIT 许可证](LICENSE)。OpenAI `tunnel-client` 通过上面的官方渠道单独获取。
