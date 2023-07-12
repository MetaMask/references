import { InjectedConnector } from './injected'
import { WindowProvider } from './types'
import {
  EventType,
  MetaMaskSDK,
  MetaMaskSDKOptions,
  SDKProvider,
} from '@metamask/sdk'
import {
  Address,
  Chain,
  ProviderRpcError,
  ResourceUnavailableRpcError,
  UserRejectedRequestError,
} from 'viem'

export type MetaMaskSDKConnectorOptions = {
  debug?: boolean
  // Keep both sdk and sdkOptions as some users might want to use their own pre-defined sdk instance
  sdk?: MetaMaskSDK
  sdkOptions?: MetaMaskSDKOptions
}

export class MetaMaskSDKConnector extends InjectedConnector {
  readonly id = 'metaMaskSDK'

  #sdk: MetaMaskSDK
  #provider?: SDKProvider
  #debug = false

  constructor({
    chains,
    options: options_,
  }: {
    chains?: Chain[]
    options?: MetaMaskSDKConnectorOptions
  } = {}) {
    if (!options_?.sdk && !options_?.sdkOptions) {
      throw new Error('MetaMaskConnector invalid sdk parameters')
    }

    let sdk
    const { debug } = options_

    if (!options_?.sdk) {
      sdk = new MetaMaskSDK(options_.sdkOptions)
    } else {
      sdk = options_.sdk
    }

    const sdkProvider = sdk.getProvider()

    const options = {
      name: 'MetaMask',
      shimDisconnect: true,
      getProvider() {
        // ignore _events from WindowProvider not implemented in SDKProvider
        return sdkProvider as unknown as WindowProvider
      },
    }

    super({ chains, options })

    this.#debug = debug ?? false
    this.#sdk = sdk
    this.#provider = sdkProvider
  }

  /**
   * Listen to sdk provider events and re-initialize events listeners accordingly
   */
  #updateProviderListeners() {
    if (this.#provider) {
      // Cleanup previous handlers first
      this.#provider?.removeListener(
        'accountsChanged',
        this.onAccountsChanged as any,
      )
      this.#provider?.removeListener('chainChanged', this.onChainChanged as any)
      this.#provider?.removeListener('disconnect', this.onDisconnect as any)
    }

    // might need to re-initialize provider if it changed
    this.#provider = this.#sdk.getProvider()

    this.#provider?.on('accountsChanged', this.onAccountsChanged as any)
    this.#provider?.on('chainChanged', this.onChainChanged as any)
    this.#provider?.on('disconnect', this.onDisconnect as any)
  }

  // Two scenarios depending on wether browser extension is installed:
  // - if installed and user chooses browser extension, then wait for SWITCH_PROVIDER event
  // - if not installed, or user chooses mobile wallet, then wait for AUTHORIZED event
  async #waitForSDK() {
    if (this.#debug) {
      console.log('MetaMaskSDKConnector waiting for SDK validation')
    }

    return new Promise((resolve) => {
      this.#sdk.once(
        EventType.PROVIDER_UPDATE,
        (_accounts: string[] | undefined) => {
          resolve(true)
        },
      )

      // backward compatibility with older wallet version that return accounts before authorization
      if (this.#sdk._getConnection()?.isAuthorized()) {
        resolve(true)
      } else {
        const waitForAuthorized = () => {
          return new Promise((resolve) => {
            this.#sdk
              ._getConnection()
              ?.getConnector()
              .once(EventType.AUTHORIZED, () => {
                resolve(true)
              })
          })
        }
        waitForAuthorized().then(() => {
          resolve(true)
        })
      }
    })
  }

  async getProvider() {
    if (!this.#sdk.isInitialized()) {
      await this.#sdk.init()
    }
    if (!this.#provider) {
      this.#provider = this.#sdk.getProvider()
    }
    return this.#provider as unknown as WindowProvider
  }

  async disconnect() {
    this.#sdk.terminate()
    super.disconnect()
  }

  async connect({ chainId }: { chainId?: number } = {}): Promise<{
    account: Address
    chain: {
      id: number
      unsupported: boolean
    }
    provider: any
  }> {
    try {
      if (!this.#sdk.isInitialized()) {
        await this.#sdk.init()
      }

      this.#sdk.connect().catch((_error: unknown) => {
        // Catch to prevent unhandled promise but can be ignored.
      })

      await this.#waitForSDK()

      // Get latest provider instance (it may have changed based on user selection)
      this.#updateProviderListeners()

      const accounts: Address[] = (await this.#provider?.request({
        method: 'eth_requestAccounts',
        params: [],
      })) as Address[]

      const selectedAccount: Address = accounts?.[0] ?? '0x'

      let providerChainId: string | null | undefined = this.#provider?.chainId
      if (!providerChainId) {
        // request chainId from provider
        providerChainId = (await this.#provider?.request({
          method: 'eth_chainId',
          params: [],
        })) as string
      }

      const chain = {
        id: parseInt(providerChainId, 16),
        unsupported: false,
      }

      if (chainId !== undefined && chain.id !== chainId) {
        const newChain = await this.switchChain(chainId)
        const unsupported = this.isChainUnsupported(newChain.id)
        chain.id = newChain.id
        chain.unsupported = unsupported
      }

      if (this.options?.shimDisconnect) {
        this.storage?.setItem(this.shimDisconnectKey, true)
      }

      const connectResponse = {
        isConnected: true,
        account: selectedAccount,
        chain,
        provider: this.#provider,
      }

      return connectResponse
    } catch (error) {
      if (this.isUserRejectedRequestError(error)) {
        throw new UserRejectedRequestError(error as Error)
      } else if ((error as ProviderRpcError).code === -32002) {
        throw new ResourceUnavailableRpcError(error as ProviderRpcError)
      }
      throw error
    }
  }
}
