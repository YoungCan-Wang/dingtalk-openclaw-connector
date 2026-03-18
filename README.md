<div align="center">
  <img alt="DingTalk" src="docs/images/dingtalk.svg" width="72" height="72" />
  <h1>Official DingTalk OpenClaw Connector</h1>
  <p>Connect DingTalk bots to OpenClaw Gateway with AI Card streaming and session management</p>
  
  <p>
    <a href="README.zh-CN.md">简体中文</a> •
    <a href="CHANGELOG.md">Changelog</a>
  </p>
</div>

---

## 📋 Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Features](#features)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Advanced Topics](#advanced-topics)
- [License](#license)

---

## Prerequisites

Before you begin, ensure you have:

### 1. Node.js

- **Version**: >= 22
- **Download**: https://nodejs.org/
- **Verify installation**:
  ```bash
  node --version
  ```

### 2. OpenClaw Gateway

- **Official Website**: https://openclaw.ai/
- **Installation**: Follow the official guide to install OpenClaw
- **Verify installation**:
  ```bash
  openclaw gateway status
  ```
  Expected output: `✓ Gateway is running on http://127.0.0.1:18789`

### 3. DingTalk Enterprise Account

- You need a DingTalk enterprise account to create internal applications
- Official Website: https://www.dingtalk.com/

---

## Quick Start

> 💡 **Goal**: Get your DingTalk bot working in ~5 minutes

### Step 1: Install the Plugin

```bash
# Recommended: Install from npm
openclaw plugins install @dingtalk-real-ai/dingtalk-connector

# Alternative: Install from Git
openclaw plugins install https://github.com/DingTalk-Real-AI/dingtalk-openclaw-connector.git
```

**Verify installation**:
```bash
openclaw plugins list
```
You should see `✓ DingTalk Channel (v0.8.0) - loaded`

---

### Step 2: Enable Chat Completions Endpoint

Edit `~/.openclaw/openclaw.json` and ensure the following configuration exists:

```json5
{
  "gateway": {
    "http": {
      "endpoints": {
        "chatCompletions": {
          "enabled": true
        }
      }
    }
  }
}
```

> ⚠️ **Important**: Without this configuration, you may encounter HTTP 405 errors.

---

### Step 3: Create a DingTalk Bot

#### 3.1 Create Application

1. Go to [DingTalk Open Platform](https://open-dev.dingtalk.com/)
2. Click **"Application Development"** → **"Enterprise Internal Development"**
3. Click **"Create Application"**

![Create Application](docs/images/image-1.png)

#### 3.2 Add Bot Capability

1. In the application details page, click **"Add Capability"**
2. Select **"Bot"**
3. Set message receiving mode to **"Stream Mode"** (NOT Webhook)

![Add Bot Capability](docs/images/image-2.png)

#### 3.3 Get Credentials

1. Go to **"Credentials & Basic Info"**
2. Copy your **AppKey** (Client ID)
3. Copy your **AppSecret** (Client Secret)

![Get Credentials](docs/images/image-3.png)

#### 3.4 Publish Application

1. Click **"Version Management"** → **"Publish"**
2. Wait for approval (usually instant for internal apps)

![Publish Application](docs/images/image-4.png)

> ⚠️ **Important**: Unpublished apps will fail with Stream connection 400 errors.

---

### Step 4: Configure OpenClaw

You have three options to configure the connector:

#### Option A: Configuration Wizard (Recommended for Beginners)

```bash
openclaw channels add
```

Select **"DingTalk (钉钉)"** and follow the prompts to enter:
- `clientId` (AppKey)
- `clientSecret` (AppSecret)
- Group policy settings

#### Option B: Edit Configuration File

Edit `~/.openclaw/openclaw.json`:

```json5
{
  "channels": {
    "dingtalk-connector": {
      "enabled": true,
      "clientId": "dingxxxxxxxxx",        // Your AppKey
      "clientSecret": "your_app_secret",  // Your AppSecret
      "dmPolicy": "open",                 // Direct message policy
      "groupPolicy": "open"               // Group chat policy
    }
  }
}
```

> 💡 **Tip**: If the file already has content, add the `dingtalk-connector` section under the `channels` node.

#### Option C: Environment Variables

```bash
export DINGTALK_CLIENT_ID="dingxxxxxxxxx"
export DINGTALK_CLIENT_SECRET="your_app_secret"
```

---

### Step 5: Restart and Test

```bash
# Restart OpenClaw Gateway
openclaw gateway restart

# Watch logs in real-time
openclaw logs --follow
```

**Test your bot**:
1. Open DingTalk app
2. Find your bot in the contact list
3. Send a message: `Hello`
4. You should receive a response within 10 seconds

---

## Features

### ✅ Core Features

- **AI Card Streaming** - Typewriter-like replies with real-time streaming
- **Session Management** - Multi-turn conversations with context preservation
- **Session Isolation** - Separate sessions for DMs, groups, and different groups
- **Auto Session Reset** - Automatic new session after 30 minutes of inactivity
- **Manual Session Reset** - Send `/new` or `新会话` to clear conversation history
- **Image Auto-Upload** - Local image paths automatically uploaded to DingTalk
- **Proactive Messaging** - Send messages to users or groups programmatically
- **Rich Media Reception** - Receive and process JPEG/PNG images, pass to vision models
- **File Attachment Extraction** - Parse .docx, .pdf, text files, and binary files
- **Audio Message Support** - Send audio messages in multiple formats (mp3, wav, amr, ogg)
- **DingTalk Docs API** - Create, append, search, and list DingTalk documents
- **Multi-Agent Routing** - Connect multiple bots to different agents for specialized services
- **Markdown Table Conversion** - Auto-convert Markdown tables to DingTalk-compatible format
- **Async Mode** - Immediate acknowledgment with background processing (optional)

---

## Configuration

### Basic Configuration

| Option | Environment Variable | Description |
|--------|---------------------|-------------|
| `clientId` | `DINGTALK_CLIENT_ID` | DingTalk AppKey |
| `clientSecret` | `DINGTALK_CLIENT_SECRET` | DingTalk AppSecret |
| `gatewayToken` | `OPENCLAW_GATEWAY_TOKEN` | Gateway auth token (optional) |
| `gatewayPassword` | — | Gateway auth password (optional, use token OR password) |
| `dmPolicy` | — | Direct message policy: `open`, `pairing`, `allowlist` |
| `groupPolicy` | — | Group chat policy: `open`, `pairing`, `allowlist` |

### Session Management

| Option | Default | Description |
|--------|---------|-------------|
| `separateSessionByConversation` | `true` | Separate sessions for DMs/groups |
| `groupSessionScope` | `group` | Group session scope: `group` (shared) or `group_sender` (per-user) |
| `sharedMemoryAcrossConversations` | `false` | Share memory across different conversations |

### Async Mode

| Option | Default | Description |
|--------|---------|-------------|
| `asyncMode` | `false` | Enable async mode for long-running tasks |
| `ackText` | `🫡 任务已接收，处理中...` | Acknowledgment message text |


---

## Troubleshooting

### Bot Not Responding

**Symptoms**: Bot doesn't reply to messages

**Solutions**:
1. Check plugin status: `openclaw plugins list`
2. Check gateway status: `openclaw gateway status`
3. Check logs: `openclaw logs --follow`
4. Verify application is published in DingTalk Open Platform

---

### HTTP 405 Error

**Symptoms**: Error message shows "405 Method Not Allowed"

**Cause**: Chat Completions endpoint not enabled

**Solution**:
1. Edit `~/.openclaw/openclaw.json`
2. Add the following configuration:
   ```json5
   {
     "gateway": {
       "http": {
         "endpoints": {
           "chatCompletions": {
             "enabled": true
           }
         }
       }
     }
   }
   ```
3. Restart gateway: `openclaw gateway restart`

---

### HTTP 401 Error

**Symptoms**: Error message shows "401 Unauthorized"

**Cause**: Gateway authentication failed

**Solution**:
1. Check `gateway.auth.token` in `~/.openclaw/openclaw.json`
2. Ensure `gatewayToken` in `channels.dingtalk-connector` matches the gateway token
3. Restart gateway: `openclaw gateway restart`

---

### Stream Connection 400 Error

**Symptoms**: Logs show "Request failed with status code 400"

**Common Causes**:

| Cause | Solution |
|-------|----------|
| Application not published | Go to DingTalk Open Platform → Version Management → Publish |
| Invalid credentials | Check `clientId`/`clientSecret` for typos or extra spaces |
| Not Stream mode | Verify bot is configured for Stream mode (not Webhook) |
| IP whitelist | Check if application has IP whitelist restrictions |

**Verification Steps**:

1. **Test credentials**:
   ```bash
   curl -X POST "https://api.dingtalk.com/v1.0/oauth2/accessToken" \
     -H "Content-Type: application/json" \
     -d '{"appKey": "your_clientId", "appSecret": "your_clientSecret"}'
   ```
   - Success: Returns `accessToken`
   - Failure: Returns `400` or `invalid`

2. **Check application status**:
   - Login to [DingTalk Open Platform](https://open-dev.dingtalk.com/)
   - Verify application is published
   - Verify bot is enabled and in Stream mode

3. **Republish application**:
   - After any configuration change, click **Save** → **Publish**

---

## Advanced Topics

### Multi-Agent Configuration

Configure multiple bots connected to different agents:

```json5
{
  "channels": {
    "dingtalk-connector": {
      "enabled": true,
      "accounts": {
        "bot1": {
          "enabled": true,
          "clientId": "ding_bot1_app_key",
          "clientSecret": "bot1_secret"
        },
        "bot2": {
          "enabled": true,
          "clientId": "ding_bot2_app_key",
          "clientSecret": "bot2_secret"
        }
      }
    }
  },
  "bindings": [
    {
      "agentId": "ding-bot1",
      "match": {
        "channel": "dingtalk-connector",
        "accountId": "bot1"
      }
    },
    {
      "agentId": "ding-bot2",
      "match": {
        "channel": "dingtalk-connector",
        "accountId": "bot2"
      }
    }
  ]
}
```

For more details, see [OpenClaw Multi-Agent Configuration Guide](https://gist.github.com/smallnest/c5c13482740fd179e40070e620f66a52).

---

### Session Commands

Users can send the following commands to start a fresh session:

- `/new`, `/reset`, `/clear`
- `新会话`, `重新开始`, `清空对话`

---

### DingTalk Docs API

Create and manage DingTalk documents from your agent:

```javascript
// Create document
dingtalk-connector.docs.create({
  spaceId: "your-space-id",
  title: "Test Document",
  content: "# Test Content"
})

// Append content
dingtalk-connector.docs.append({
  docId: "your-doc-id",
  markdownContent: "\n## Appended Content"
})

// Search documents
dingtalk-connector.docs.search({
  keyword: "search keyword"
})

// List documents
dingtalk-connector.docs.list({
  spaceId: "your-space-id"
})
```

---

## Project Structure

```
dingtalk-openclaw-connector/
├── src/
│   ├── core/           # Core connector logic
│   ├── services/       # DingTalk API services
│   ├── utils/          # Utility functions
│   └── types/          # TypeScript type definitions
├── docs/
│   └── images/         # Documentation images
├── openclaw.plugin.json # Plugin manifest
├── package.json        # npm dependencies
└── LICENSE
```

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `dingtalk-stream` | DingTalk Stream protocol client |
| `axios` | HTTP client |
| `mammoth` | Word document (.docx) parsing |
| `pdf-parse` | PDF document parsing |

---

## License

[MIT](LICENSE)

---

## Support

- **Issues**: [GitHub Issues](https://github.com/DingTalk-Real-AI/dingtalk-openclaw-connector/issues)
- **Changelog**: [CHANGELOG.md](CHANGELOG.md)
