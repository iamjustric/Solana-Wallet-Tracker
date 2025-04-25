# Solana Wallet Tracker

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)  [![Donate](https://img.shields.io/badge/Donate-☕-orange)](https://github.com/sponsors/iamjustric)

A CLI-based, wallet tracker for monitoring real-time Solana wallet activity. Supports Raydium, PumpFun, and Jupiter DEXes.

---

## 🛠️ Features

- **Real-time Tracking** of specified wallets.
- **Multi-DEX Support**: Raydium, PumpFun, Jupiter, more coming soon.
- **Modular Architecture**: separate handlers for each protocol.
- **Caching System**: In-memory caching of the bot and personal portfolio states to avoid redundant computations and support graceful restarts.
- **Structured Logging**: Standardized `info`, `warn`, `error` and `debug` logs with timestamps.
- **Easy Configuration** via file and environment variables

## 🚀 Getting Started

### Prerequisites

- Node.js v18+
- npm
- Solana RPC endpoint URL and a Base58 private key

### Installation

```bash
git clone https://github.com/iamjustric/Solana-Wallet-Tracker.git
cd Solana-Wallet-Tracker
npm install 
```

### Configuration

1. Copy and edit the example environment file:

   ```bash
   cp .env.example .env
   ```

2. Open `.env` and set the following variables:

   ```dotenv
    ;RPC_SETTINGS
    RPC_URL=<Solana RPC URL>
    WSS_ENDPOINT=<RPC WebSocket URL>
    ENHANCED_WSS=<Geyser WebSocket URL>

    ;WALLET_SETTINGS
    PRIVATE_KEY=<Base58 private key>
    PUBLIC_KEY=<Public key>

    ;BOT_SETTINGS
    RAYDIUM_SLIPPAGE=<Raydium slippage, for example: 1 means 1%>
    PUMPFUN_SLIPPAGE=<PumpFun slippage, for example: 1 means 1%>
    JUPITER_SLIPPAGE=<Jupiter slippage, for example: 100 means 1%>
    AMOUNT=<SOL amount per trade, for example: 0.1>
    PRIORITY_FEE_IN_SOL=<priority fee, for example: 0.0001>
    JITO_FEE_IN_SOL=<Jito tip fee, for example: 0.0001>
    LOGGING_LEVEL=info
   ```

3. List target wallets in `wallet_list.txt`:

   ```bash
     WalletPubkey1
     WalletPubkey2
   ```

### Running the Bot

```bash
npm start
```
The CLI will start, connect to the specified WebSocket endpoint, and begin logging and mirroring detected swaps.

---

## 📦 Project Structure

```
├── common                        # Shared utilities and common functionality
│   ├── interfaces                # Interfaces used throughout the app
│   │   └── interfaces.ts
│   ├── logging                   #Logging configuration
│   │   └── loggerManager.ts
│   └── utils                     # General utility functions
│       └── index.ts
├── constants                     # Constants and configurations used globally
│   └── constants.ts
├── services                      # Core application services
│   ├── IDL                       # Dex IDL files for interacting with smart contracts ???
│   ├── walletTracker
│       └── src
│           ├── app.ts            # CLI entrypoint for the bot
│           └── WalletTracker.ts  # Core logic for tracking and mirroring trades
│── src
│   ├── jupiter
│   │   ├── jupiterSwap.ts        # Jupiter SDK wrapper
│   │   └── jupiterHandler.ts     # Jupiter-specific trade handler
│   ├── raydium
│   │   ├── raydiumSwap.ts        # Raydium SDK wrapper
│   │   └── raydiumHandler.ts     # Raydium-specific trade handler
│   └── pumpfun
│       ├── pumpfunSwap.ts        # PumpFun SDK wrapper
│       └── pumpfunHandler.ts     # PumpFun-specific trade handler
│  
├── .env.example                  # Example env vars
├── LICENSE                       # Apache 2.0 License
└── README.md                     # This file
```

---

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/name`)
3. Commit your changes (`git commit -am 'Add new feature'`)
4. Push to the branch (`git push origin feature/name`)
5. Open a Pull Request

---

## ❤️ Support the Project

If you find this tool useful and want to support ongoing development, consider becoming a sponsor or making a donation:

[![Sponsor iamjustric](https://img.shields.io/badge/Sponsor-iamjustric-%23ea4aaa.svg)](https://github.com/sponsors/iamjustric)

---

## 📜 License

This project is licensed under the **Apache License 2.0**. See the [LICENSE](LICENSE) file for details.

