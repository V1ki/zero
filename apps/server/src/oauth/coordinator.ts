import type { Vault } from '@zero-os/secrets'
import { ManagedOAuthAttempts } from './attempt'
import {
  type ManagedOAuthCoordinatorOptions,
  type ResolvedOAuthCallbackConfig,
  parseDefaultOAuthCallbackConfig,
} from './callback'
import type { ManagedOAuthDriver, ManagedOAuthProvider } from './driver'
import {
  type ManagedOAuthStatus,
  type ManagedOAuthStatusRefreshOptions,
  readManagedOAuthStatus,
  refreshManagedOAuthStatus,
  waitForManagedOAuthCompletion,
} from './status'

class ManagedOAuthDriverRegistry {
  private readonly drivers = new Map<ManagedOAuthProvider, ManagedOAuthDriver>()

  constructor(drivers: ManagedOAuthDriver[] = []) {
    for (const driver of drivers) {
      this.register(driver)
    }
  }

  register(driver: ManagedOAuthDriver): void {
    this.drivers.set(driver.provider, driver)
  }

  supports(provider: string): provider is ManagedOAuthProvider {
    return this.drivers.has(provider as ManagedOAuthProvider)
  }

  require(provider: ManagedOAuthProvider): ManagedOAuthDriver {
    const driver = this.drivers.get(provider)
    if (!driver) {
      throw new Error(`Unsupported OAuth provider: ${provider}`)
    }
    return driver
  }
}

export class ManagedOAuthCoordinator {
  private vault: Vault
  private drivers: ManagedOAuthDriverRegistry
  private attempts: ManagedOAuthAttempts
  private readonly defaultCallbackConfig: ResolvedOAuthCallbackConfig

  constructor(
    vault: Vault,
    drivers: ManagedOAuthDriver[],
    options: ManagedOAuthCoordinatorOptions = {},
  ) {
    this.vault = vault
    this.drivers = new ManagedOAuthDriverRegistry(drivers)
    this.defaultCallbackConfig = parseDefaultOAuthCallbackConfig(options)
    this.attempts = new ManagedOAuthAttempts(vault, (provider) => this.drivers.require(provider))
  }

  registerDriver(driver: ManagedOAuthDriver): void {
    this.drivers.register(driver)
  }

  supportsProvider(provider: string): provider is ManagedOAuthProvider {
    return this.drivers.supports(provider)
  }

  getStatus(provider: ManagedOAuthProvider): ManagedOAuthStatus {
    return readManagedOAuthStatus({
      provider,
      driver: this.drivers.require(provider),
      vault: this.vault,
      attempt: this.attempts.get(provider),
    })
  }

  async getStatusWithRefresh(
    provider: ManagedOAuthProvider,
    options: ManagedOAuthStatusRefreshOptions = {},
  ): Promise<ManagedOAuthStatus> {
    if (this.attempts.get(provider)) {
      return this.getStatus(provider)
    }

    return refreshManagedOAuthStatus({
      provider,
      driver: this.drivers.require(provider),
      vault: this.vault,
      options,
    })
  }

  async start(provider: ManagedOAuthProvider): Promise<{ attemptId: string; url: string }> {
    this.drivers.require(provider)
    return await this.attempts.start(provider, this.defaultCallbackConfig)
  }

  async completeFromInput(
    provider: ManagedOAuthProvider,
    rawInput: string,
  ): Promise<ManagedOAuthStatus> {
    await this.attempts.completeFromInput(provider, rawInput)
    return this.getStatus(provider)
  }

  async waitForCompletion(
    provider: ManagedOAuthProvider,
    timeoutMs = 120_000,
  ): Promise<ManagedOAuthStatus> {
    return await waitForManagedOAuthCompletion({
      provider,
      timeoutMs,
      getStatus: (statusProvider) => this.getStatus(statusProvider),
    })
  }
}
