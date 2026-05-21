# OpLab MCP Server

An MCP (Model Context Protocol) server exposing **29 tools** across all 9 categories of the [OpLab API](https://oplab.com.br) for Brazilian stock market data. Connect it to Claude Desktop and ask questions in plain language.

## Tools (29 total)

### 1. Cotações e Instrumentos
| Tool | Description |
|---|---|
| `get_stock_quote` | Current price, OHLCV, bid/ask, IV rank, trends, OpLab score |
| `get_instrument_details` | Full analytics for multiple symbols at once |
| `search_instruments` | Search by name or symbol substring |

### 2. Ações / Stocks
| Tool | Description |
|---|---|
| `list_stocks` | All ~242 stocks with analytics (filterable by name/symbol) |
| `list_all_stocks` | All B3 stocks with pagination (includes those without options) |
| `get_stock_details` | Full details + financials for a specific stock |

### 3. Opções
| Tool | Description |
|---|---|
| `get_options_chain` | Full chain (CALL + PUT) for any stock — 3,500+ for PETR4 |
| `get_option_details` | Detailed data for a single option contract |
| `get_covered_call_options` | Options suitable for covered call strategies |
| `get_popular_options` | Most actively traded options today (63k+ contracts) |
| `calculate_black_scholes` | Theoretical option pricing via Black-Scholes |

### 4. Dados Históricos
| Tool | Description |
|---|---|
| `get_historical_candles` | OHLCV candles for any resolution (1m → monthly) |
| `get_options_historical_range` | Historical data for all options over a date range |

### 5. Rankings e Estatísticas
| Tool | Description |
|---|---|
| `get_oplab_score_ranking` | Stocks ranked by OpLab's composite score |
| `get_ranking_by_attribute` | Rank by any attribute (IV, EWMA, entropy, etc.) |
| `get_trending_options` | Stocks with strongest MA9 vs MA21 trends |
| `get_ibov_correlation_ranking` | Stocks ranked by Ibovespa correlation |
| `get_best_covered_call_rates` | Options with best annualized covered call yield |
| `get_highest_option_variations` | Options with largest price moves today |
| `get_highest_option_volume` | Options with highest trading volume today |

### 6. Bolsas de Valores
| Tool | Description |
|---|---|
| `list_exchanges` | All exchanges (B3/BVMF, BCB, etc.) with trading hours |
| `get_exchange_details` | Details for a specific exchange |

### 7. Companhias
| Tool | Description |
|---|---|
| `get_companies_info` | Corporate data (CNPJ, sector) for one or more companies |

### 8. Taxas de Juros
| Tool | Description |
|---|---|
| `list_interest_rates` | All tracked rates (SELIC, CDI) with current values |
| `get_interest_rate` | Details for a specific rate |

### 9. Status do Mercado
| Tool | Description |
|---|---|
| `get_market_status` | Whether B3 is currently open or closed |

---

## Setup

### 1. Install dependencies

```bash
cd mcp-server
uv venv .venv
uv pip install --python .venv/bin/python3 fastmcp httpx
```

### 2. Set your OpLab API token

Get your token at [go.oplab.com.br/api](https://go.oplab.com.br/api) and set it:

```bash
export OPLAB_ACCESS_TOKEN=your_token_here
```

### 3. Run the server

```bash
.venv/bin/python3 server.py
```

---

## Claude Desktop integration

Add to your `claude_desktop_config.json`:

**Mac/Linux:** `~/.config/Claude/claude_desktop_config.json`  
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "oplab": {
      "command": "/absolute/path/to/mcp-server/.venv/bin/python3",
      "args": ["/absolute/path/to/mcp-server/server.py"],
      "env": {
        "OPLAB_ACCESS_TOKEN": "your_token_here"
      }
    }
  }
}
```

Or with `uv run` (no install needed):

```json
{
  "mcpServers": {
    "oplab": {
      "command": "uv",
      "args": [
        "run",
        "--with", "fastmcp",
        "--with", "httpx",
        "/absolute/path/to/mcp-server/server.py"
      ],
      "env": {
        "OPLAB_ACCESS_TOKEN": "your_token_here"
      }
    }
  }
}
```

Restart Claude Desktop after editing. Verify by clicking **+** → **Connectors** — "oplab" should appear.

---

## Example prompts

```
What is the current price and IV rank of PETR4?
List the top 10 stocks by OpLab score
Show me the PETR4 daily candles for the last 30 days
Which CALL options have the highest volume today?
What are the best covered call rates available right now?
Is the B3 market currently open?
What is the current SELIC rate?
Show me VALE3's options expiring in June
Which stocks have the strongest uptrend right now?
Compare the options chains of ITUB4 and BBDC4
```

---

## Ticker examples

| Symbol | Instrument |
|---|---|
| PETR4 | Petrobras PN |
| VALE3 | Vale ON |
| ITUB4 | Itaú Unibanco PN |
| BBDC4 | Bradesco PN |
| ABEV3 | Ambev ON |
| BOVA11 | Ibovespa ETF |
| MGLU3 | Magazine Luiza ON |
| WEGE3 | WEG ON |

## Historical data resolutions

| Value | Interval |
|---|---|
| `1` | 1 minute |
| `5` | 5 minutes |
| `15` | 15 minutes |
| `30` | 30 minutes |
| `60` / `1h` | 1 hour |
| `1d` | Daily (default) |
| `1w` | Weekly |
| `1M` | Monthly |

## Notes

- `calculate_black_scholes` depends on OpLab's server-side calculation and may return a 500 error intermittently — this is an upstream API issue, not a bug in the server.
- `get_exchange_details` for individual exchanges may return no content (204) depending on the exchange uid; use `list_exchanges` to discover valid uids.
- Data is always live/real-time; nothing is cached.
