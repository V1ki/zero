export function printHelp(): void {
  console.log(`
ZeRo OS CLI

Usage:
  bun zero <command>

Commands:
  init [api-key]     Initialize ZeRo OS (Keychain, vault, directories)
  start              Start ZeRo OS (server + web UI)
  restart            Graceful restart (requires Supervisor running)
  launchctl install  Install/update macOS LaunchAgent for Supervisor
  launchctl status   Show macOS LaunchAgent status
  launchctl uninstall Remove macOS LaunchAgent for Supervisor
  logs [target]      View supervisor logs (supervisor | error | all)
  secret set <k> <v> Store a secret in the vault
  secret list        List all stored secret keys
  secret delete <k>  Delete a secret
  weixin login       Authenticate a Weixin channel via QR login
  provider login <provider> [--name name] Authenticate managed OAuth
  status             Show system status

Examples:
  bun zero init sk-your-api-key-here
  bun zero start
  bun zero restart
  bun zero launchctl install
  bun zero logs all --follow
  bun zero secret set openai_codex_api_key sk-xxx
  bun zero weixin login
  bun zero provider login chatgpt
  bun zero provider login chatgpt --name work
  bun zero provider login anthropic
  bun zero provider login x-premium
  bun zero status
`)
}
