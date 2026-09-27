# Personal Chrome companion (F247)

`@clowder-ai/personal-chrome-companion` is the public, packable source closure
for F247's narrow Chrome MV3 and Native Messaging companion. It exports the
versioned v1 machine grammar, a static extension, the POSIX helper CLI, and a
declarative Clowder module plugin (`plugin.yaml`, plugin id
`official.companion.personal-chrome`) that hosts authorized ChatGPT
conversations for the cloud cat.

The Host-loadable builtin runtime is implemented in this package:
`runtime.transport: builtin` with entrypoint `dist/plugin-entrypoint.js`. The
plugin declares `runtime.dataDirectory: personal-chrome-host`, so the Host
provisions `<projectRoot>/.cat-cafe/plugin-host/personal-chrome-host` (0700)
and grants it to the feature through the `data.directory` capability.

## Module plugin surface

The `personal-chrome-host` feature owns one `cloud-conversation-host`
contribution (`provider: chatgpt`). Its three conversation methods are **p2a
placeholders**; p2b replaces them with the native-host socket client:

- `personal-chrome-host.append-message` — currently always
  `{ status: 'failed', errorCode: 'HOST_UNAVAILABLE' }` (the request never
  leaves the package, so no effect could have happened).
- `personal-chrome-host.assistant-returns.list` — currently `{ returns: [] }`.
- `personal-chrome-host.assistant-returns.ack` — currently
  `{ status: 'failed', errorCode: 'HOST_UNAVAILABLE' }`.

The `personalChromeAuthorizations` operation lists the authorized
conversations as Host-rendered rows (one `revoke` row action each), revokes one
authorization by `conversationId`, and reports authorization status. The
underlying store holds at most 32 authorizations; the operation surfaces that
ceiling through the status action.

## Owner-run native host installation

The Native Messaging manifest and launcher installation is an **owner-run
CLI**, shipped in the package at `native-host/install-host.mjs`; the plugin
does not install anything by itself and no extra capability is requested for
it.

Prerequisites: Node.js >= 20 on macOS or Linux (Windows is unsupported), the
project root that runs the Host (`<projectRoot>/.cat-cafe` must be the
directory the Host provisions), and the unpacked extension id of the Chrome
MV3 extension loaded from `extension/` (a 32-character Chrome id).

Run everything from the project root. First inspect the plan (no writes):

```sh
/path/to/node node_modules/@clowder-ai/personal-chrome-companion/native-host/install-host.mjs \
  --extension-id <unpacked-extension-id> \
  --host-path /path/to/node
```

Then apply it. Installation is exposed as a library call
(`installNativeHost`), so the owner applies the plan with a one-liner:

```sh
/path/to/node --input-type=module -e "
import { installNativeHost } from '@clowder-ai/personal-chrome-companion/native-host/install-host';
const receipt = await installNativeHost({
  projectRoot: process.cwd(),
  extensionId: '<unpacked-extension-id>',
  nodeExecutable: '/path/to/node',
});
console.log(JSON.stringify(receipt, null, 2));
"
```

After installation, verify:

```sh
# The module data directory holds the pairing record and helper digest.
ls .cat-cafe/plugin-host/personal-chrome-host

# The browser-side manifest exists (macOS example).
ls "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/dev.clowder.personal_chrome.json"

# The helper answers the CLI.
clowder-personal-chrome-host --help
```

Uninstall is the symmetric call; it reverses the out-of-directory writes and
removes the conversation authorizations while retaining the delivery ledger,
matching Host uninstall semantics:

```sh
/path/to/node --input-type=module -e "
import { uninstallNativeHost } from '@clowder-ai/personal-chrome-companion/native-host/install-host';
console.log(JSON.stringify(await uninstallNativeHost({ projectRoot: process.cwd() }), null, 2));
"
```

## Helper entrypoint

```sh
clowder-personal-chrome-host --help
```

The executable is POSIX-only. It requires either a Cat Café-created
`--pairing-record /absolute/path.json` or all three Host-supplied variables:

```text
CAT_CAFE_PERSONAL_CHROME_SOCKET
CAT_CAFE_PERSONAL_CHROME_LEDGER
CAT_CAFE_PERSONAL_CHROME_PAIRING_SECRET
```

## Authority boundary

Cat Café remains responsible for catalog/SRI/admission, pairing-secret
issuance and rotation, lifecycle supervision, Settings/onboarding, and
user-visible status. The installed helper receives a complete Host-supplied
pairing record or environment configuration; it never generates a secret or
chooses an install path.

The extension may bind only an explicitly clicked exact
`https://chatgpt.com/c/<id>` conversation. Normal dispatch finds that exact
background tab and sends the append request without focusing, navigating,
reloading, activating, selecting, moving, highlighting, reading cookies, or
calling a private ChatGPT API.

## Release status

This package is a review candidate only. It does not publish to npm or the
Chrome Web Store. Signed Chrome Web Store identity/admission, Settings
onboarding, and Windows support remain open; Windows is explicitly
unsupported.
