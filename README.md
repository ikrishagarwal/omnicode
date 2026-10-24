# OmniCode

OmniCode is a small, telemetry-free CLI:

```text
omnicode login
omnicode proxy
omnicode update
```

> **Educational proof of concept:** OmniCode is provided solely for
> educational, research, and interoperability purposes. It is experimental
> software and is not intended for production use. Read the full
> [disclaimer](DISCLAIMER.md) before using, modifying, or distributing it.

You are solely responsible for how you use this software and for complying
with all applicable laws, regulations, contracts, third-party rights, and
terms of service. The repository owner and contributors do not authorize,
endorse, or assume responsibility for misuse of this project.

## Installation

### Step 1

Clone the repository.

### Step 2

From the repository directory, make the CLI entry point executable if needed:

```sh
chmod +x src/cli.js
```

### Step 3

Then link OmniCode globally with the package manager you use:

```sh
# npm
npm link

# pnpm
pnpm link --global

# Yarn
yarn link

# Bun
bun link
```

#### Step 4

Verify that the command is available:

```sh
omnicode --help
```

## Updating

Because `npm link` points the global command at this checkout, updating the
checkout updates the linked command in place. You do not need to run `npm link`
again unless package metadata or the `bin` entry changes.

```sh
omnicode update
```

The command fetches the current branch's upstream and only fast-forwards. It
refuses to update when the working tree has uncommitted changes, the branch has
no upstream, or local and remote commits have diverged. It never discards local
work.

To check without changing files:

```sh
omnicode update --check
```

Restart `omnicode proxy` after updating so the running process loads the new
code. If the update changes dependencies or package metadata, re-run your
package manager or link command.

## Login

`omnicode login` uses the OmniRush device flow and writes the compatible
credential file at `~/.omnirush/auth.json`. Set `OMNIRUSH_DIR` to use another
state directory. Use `--no-open` to print the approval URL without launching a
browser.

## Proxy

`omnicode proxy` requires a completed login and starts a loopback proxy at
`127.0.0.1:8789`. The port can be changed with `--port` or
`OMNICODE_PROXY_PORT`.

The command creates a persistent local API key at
`~/.omnirush/proxy-key` with private file permissions and reuses it on later
starts. The cloud access and refresh tokens are not printed, persisted in proxy
configuration, or sent to the local client. To rotate the local key, stop the
proxy, delete `~/.omnirush/proxy-key`, and start the proxy again.

If `OMNIRUSH_DIR` is set, the key is stored as `$OMNIRUSH_DIR/proxy-key`
instead.

The proxy refreshes rotated credentials and updates the shared `auth.json`, so
the OmniCode proxy and a later OmniRush CLI installation can use the same
login state.

OmniCode reports an OmniRush CLI release version to the gateway. It reads the
version from `omnirush_package/node_modules/omnirush/package.json` when that
reference install is present, then from an installed `omnirush` package,
otherwise it uses the built-in default. Override it when OmniRush requires a
newer release:

```sh
OMNIRUSH_CLIENT_VERSION=2.6.9 omnicode proxy
```

Only one proxy can listen on a port. If `omnicode proxy` reports that port
`8789` is already in use, an OmniCode proxy may already be running; leave it
running and start OpenCode. To inspect the listener:

```sh
ss -ltnp 'sport = :8789'
```

To use a different port instead:

```sh
omnicode proxy --port 8790
```

Then change the OpenCode `baseURL` port from `8789` to `8790`.

## Use with OpenCode

Open two terminals. Keep the proxy running in the first one:

```sh
omnicode login
omnicode proxy
```

The proxy uses the persistent local key at `~/.omnirush/proxy-key`; it is not
the OmniRush access token. OpenCode can read the key directly, so no key needs
to be copied into a terminal each time.

OmniRush currently lists these three models:

| Model ID      | Display name |
| ------------- | ------------ |
| `gpt-6-astra` | GPT 6 Astra  |
| `gpt-6.1-sol` | GPT 6.1 Sol  |
| `gpt-6-sol`   | GPT 6 Sol    |

Create or update your OpenCode configuration at
`~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "omnicode/gpt-6-astra",
  "provider": {
    "omnicode": {
      "npm": "@ai-sdk/openai",
      "name": "OmniCode",
      "options": {
        "baseURL": "http://127.0.0.1:8789/omnirush/v1",
        "apiKey": "{file:~/.omnirush/proxy-key}"
      },
      "models": {
        "gpt-6-astra": {
          "name": "GPT 6 Astra"
        },
        "gpt-6.1-sol": {
          "name": "GPT 6.1 Sol"
        },
        "gpt-6-sol": {
          "name": "GPT 6 Sol"
        }
      }
    }
  }
}
```

Do not add `enabled_providers: ["omnicode"]` unless you intentionally want to
hide every other OpenCode provider. Leaving `enabled_providers` out keeps
OmniCode available alongside your existing OpenAI, Anthropic, OpenRouter, and
other configured providers.

Then start OpenCode normally from the second terminal:

```sh
opencode
```

If you started the proxy with a different port, replace `8789` in
`baseURL` with that port. The `/omnirush/v1` suffix is required. If you use
`OMNIRUSH_DIR`, replace `~/.omnirush/proxy-key` in the config with the
corresponding absolute path. OpenCode reads
the local key from the file and sends it to OmniCode; OmniCode supplies the
changing cloud bearer token only on its upstream request. Do not commit
`proxy-key` or `auth.json` to a project repository.

### Troubleshooting no response

Confirm that OpenCode resolved the standalone configuration:

```sh
opencode debug config
```

The resolved configuration should show `omnicode` in `enabled_providers`,
`omnicode/gpt-6-astra` as the model, and the loopback base URL above. If it
instead shows an `omnirush` provider or a different port, an existing
`OPENCODE_CONFIG` environment override is taking precedence. This commonly
happens when OpenCode is launched from a shell previously created by the
OmniRush CLI. Start OpenCode from a clean shell, or run:

```sh
env -u OPENCODE_CONFIG -u OPENCODE_CONFIG_CONTENT \
  -u OPENCODE_DISABLE_MODELS_FETCH opencode
```

For the current shell, the equivalent is:

```sh
unset OPENCODE_CONFIG OPENCODE_CONFIG_CONTENT OPENCODE_DISABLE_MODELS_FETCH
opencode
```

For a visible one-request diagnostic, use:

```sh
env -u OPENCODE_CONFIG -u OPENCODE_CONFIG_CONTENT \
  opencode run --print-logs -m omnicode/gpt-6-astra "Reply with exactly OK"
```

An OmniRush `429 daily_grant_exhausted` response means the account has no
available grant and the proxy is working. Restart the proxy after updating
OmniCode so it uses the corrected bare `omnirush` gateway User-Agent; an old
proxy can otherwise return `403 client_not_allowed`.

If OmniRush says the reported client version is no longer supported, set
`OMNIRUSH_CLIENT_VERSION` to the installed OmniRush release and restart the
proxy, or update the reference package under `omnirush_package`:

```sh
OMNIRUSH_CLIENT_VERSION=2.6.9 omnicode proxy
```

## Verification

This package uses pnpm as declared by `devEngines`:

```sh
pnpm test
```

OmniCode does not import or run OmniRush analytics, PostHog, crash reporting,
session capture, or upload modules.
