import { InjectedConnector } from './injected'
import { WindowProvider } from './types'

import { MetaMaskSDK, MetaMaskSDKOptions, SDKProvider } from '@metamask/sdk'
import {
  Address,
  Chain,
  ProviderRpcError,
  ResourceUnavailableRpcError,
  UserRejectedRequestError,
} from 'viem'

export type MetaMaskSDKConnectorOptions = {
  // Keep both sdk and sdkOptions as some users might want to use their own pre-defined sdk instance
  sdk?: MetaMaskSDK
  sdkOptions?: MetaMaskSDKOptions
}

export class MetaMaskSDKConnector extends InjectedConnector {
  readonly id = 'metaMaskSDK'

  #sdk: MetaMaskSDK
  #provider?: SDKProvider

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

    if (options_?.sdk) {
      sdk = options_.sdk
    } else {
      // force source to 'wagmi' for analytics
      if (!options_.sdkOptions)
        options_.sdkOptions = {
          dappMetadata: { name: 'wagmi' },
        }
      options_.sdkOptions._source = 'wagmi'
      sdk = new MetaMaskSDK(options_.sdkOptions)
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

    this.#sdk = sdk
    this.#provider = sdkProvider
  }

  /**
   * Listen to sdk provider events and re-initialize events listeners accordingly
   */
  #updateProviderListeners() {
    if (this.#provider) {
      // Cleanup previous handlers first
      this.#provider?.removeListener('accountsChanged', this.onAccountsChanged)
      this.#provider?.removeListener('chainChanged', this.onChainChanged)
      this.#provider?.removeListener('disconnect', this.onDisconnect)
    }

    // might need to re-initialize provider if it changed
    this.#provider = this.#sdk.getProvider()

    this.#provider?.on(
      'accountsChanged',
      this.onAccountsChanged as (...args: unknown[]) => void,
    )
    this.#provider?.on(
      'chainChanged',
      this.onChainChanged as (...args: unknown[]) => void,
    )
    this.#provider?.on(
      'disconnect',
      this.onDisconnect as (...args: unknown[]) => void,
    )
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
    provider?: SDKProvider
  }> {
    try {
      if (!this.#sdk.isInitialized()) {
        await this.#sdk.init()
      }

      const accounts = (await this.#sdk.connect()) as Address[]

      // Get latest provider instance (it may have changed based on user selection)
      this.#updateProviderListeners()

      // backward compatibility with older wallet (<7.3) version that return accounts before authorization
      if (
        !this.#sdk.isExtensionActive() &&
        !this.#sdk._getConnection()?.isAuthorized()
      ) {
        const waitForAuthorized = () => {
          return new Promise((resolve) => {
            this.#sdk
              ._getConnection()
              ?.getConnector()
              .once('authorized', () => {
                resolve(true)
              })
          })
        }
        await waitForAuthorized()
      }

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
