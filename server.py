"""
OpLab MCP Server — Brazilian stock market data via the OpLab API v3.

Covers all 29 market endpoints across 9 categories:
  1. Cotações e Instrumentos (4)
  2. Ações / Stocks          (3)
  3. Opções                  (5)
  4. Dados Históricos        (3)
  5. Rankings e Estatísticas (7)
  6. Bolsas de Valores       (2)
  7. Companhias              (1)
  8. Taxas de Juros          (2)
  9. Status do Mercado       (1)

Authentication: Access-Token header (OPLAB_ACCESS_TOKEN env var)
API base: https://api.oplab.com.br/v3/market
"""

import os
from typing import Optional

import httpx
from fastmcp import FastMCP

OPLAB_BASE_URL = "https://api.oplab.com.br/v3/market"

mcp = FastMCP(
    name="oplab",
    instructions=(
        "Access real-time and historical data for the Brazilian stock market via OpLab. "
        "Available tools cover: current quotes, stock listings, options chains, historical "
        "OHLCV candles, rankings/statistics, interest rates (SELIC/CDI), exchange info, "
        "and market open/closed status. All data is from B3 (Bovespa)."
    ),
)


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def _client() -> httpx.Client:
    token = os.environ.get("OPLAB_ACCESS_TOKEN")
    if not token:
        raise RuntimeError(
            "OPLAB_ACCESS_TOKEN environment variable is not set. "
            "Obtain your token at https://go.oplab.com.br/api and export it."
        )
    return httpx.Client(
        base_url=OPLAB_BASE_URL,
        headers={"Access-Token": token},
        timeout=20.0,
    )


def _check(response: httpx.Response) -> None:
    if response.status_code == 204:
        return
    if response.status_code == 401:
        raise RuntimeError("Invalid or expired OpLab access token.")
    if response.status_code == 403:
        raise RuntimeError(
            "Access denied — this endpoint may require a higher OpLab plan tier."
        )
    if response.status_code == 404:
        raise ValueError(
            f"Resource not found: {response.url}. Check the symbol or parameters."
        )
    if response.status_code == 429:
        raise RuntimeError("OpLab rate limit exceeded. Try again later.")
    response.raise_for_status()


def _get(path: str, params: Optional[dict] = None) -> object:
    """Execute a GET request and return the parsed JSON (or None for 204)."""
    with _client() as c:
        r = c.get(path, params={k: v for k, v in (params or {}).items() if v is not None})
        _check(r)
        if r.status_code == 204:
            return None
        return r.json()


# ===========================================================================
# 1. COTAÇÕES E INSTRUMENTOS
# ===========================================================================

@mcp.tool()
def get_stock_quote(symbol: str) -> dict:
    """Get the current quote and full analytics for a Brazilian stock.

    Returns price (open/high/low/close), bid/ask, volume, variation %, implied
    volatility, EWMA percentiles, trend indicators, OpLab score, and more.

    Args:
        symbol: Ticker symbol, e.g. PETR4, VALE3, ITUB4, ABEV3, BOVA11.

    Returns:
        Dict with the complete current quote and analytics for the symbol.
    """
    d = _get(f"/instruments/{symbol.upper()}")
    return {
        "symbol":            d.get("symbol"),
        "name":              d.get("name"),
        "type":              d.get("type"),
        "category":          d.get("category"),
        "sector":            d.get("sector"),
        "open":              d.get("open"),
        "high":              d.get("high"),
        "low":               d.get("low"),
        "close":             d.get("close"),
        "previous_close":    d.get("previous_close"),
        "variation_pct":     d.get("variation"),
        "bid":               d.get("bid"),
        "bid_volume":        d.get("bid_volume"),
        "ask":               d.get("ask"),
        "ask_volume":        d.get("ask_volume"),
        "volume":            d.get("volume"),
        "financial_volume":  d.get("financial_volume"),
        "time":              d.get("time"),
        "last_trade_at":     d.get("last_trade_at"),
        "iv_current":        d.get("iv_current"),
        "iv_1y_percentile":  d.get("iv_1y_percentile"),
        "iv_1y_rank":        d.get("iv_1y_rank"),
        "ewma_current":      d.get("ewma_current"),
        "ewma_1y_percentile":d.get("ewma_1y_percentile"),
        "short_term_trend":  d.get("short_term_trend"),
        "middle_term_trend": d.get("middle_term_trend"),
        "beta_ibov":         d.get("beta_ibov"),
        "correl_ibov":       d.get("correl_ibov"),
        "stdv_1y":           d.get("stdv_1y"),
        "stdv_5d":           d.get("stdv_5d"),
        "semi_return_1y":    d.get("semi_return_1y"),
        "oplab_score":       d.get("oplab_score"),
        "has_options":       d.get("has_options"),
        "isin":              d.get("isin"),
    }


@mcp.tool()
def get_instrument_details(symbols: str) -> list:
    """Get detailed data for multiple instruments at once.

    Args:
        symbols: Comma-separated ticker symbols, e.g. "PETR4,VALE3,ITUB4".

    Returns:
        List of instrument dicts with full analytics for each symbol.
    """
    d = _get("/instruments", {"symbols": symbols.upper()})
    if d is None:
        return []
    return d if isinstance(d, list) else [d]


@mcp.tool()
def search_instruments(
    query: str,
    limit: int = 20,
    offset: int = 0,
) -> list:
    """Search for instruments by name or symbol substring.

    Args:
        query: Search term, e.g. "Petrobras", "Banco", "PETR".
        limit: Maximum results to return (default 20).
        offset: Pagination offset (default 0).

    Returns:
        List of matching instruments with symbol, name, and type.
    """
    d = _get("/instruments/search", {"q": query, "limit": limit, "offset": offset})
    if d is None:
        return []
    return d if isinstance(d, list) else d.get("instruments", [d])


# ===========================================================================
# 2. AÇÕES / STOCKS
# ===========================================================================

@mcp.tool()
def list_stocks(
    search: Optional[str] = None,
    limit: int = 50,
) -> list:
    """List all Brazilian stocks that have options listed on B3.

    Returns ~240 stocks with quotes, IV rank, trends, and OpLab analytics.
    Optionally filter by symbol or name substring.

    Args:
        search: Case-insensitive filter by symbol or name, e.g. "VALE", "BANCO".
                Leave empty to return all.
        limit: Maximum results (default 50, max 500).

    Returns:
        List of stocks with symbol, name, sector, close, variation %, IV, trends.
    """
    limit = min(max(1, limit), 500)
    data: list = _get("/stocks") or []

    if search:
        q = search.upper()
        data = [
            i for i in data
            if q in i.get("symbol", "").upper() or q in i.get("name", "").upper()
        ]

    return [
        {
            "symbol":           item.get("symbol"),
            "name":             item.get("name"),
            "sector":           item.get("sector", ""),
            "category":         item.get("category"),
            "close":            item.get("close"),
            "previous_close":   item.get("previous_close"),
            "variation_pct":    item.get("variation"),
            "volume":           item.get("volume"),
            "financial_volume": item.get("financial_volume"),
            "iv_current":       item.get("iv_current"),
            "iv_1y_rank":       item.get("iv_1y_rank"),
            "short_term_trend": item.get("short_term_trend"),
            "middle_term_trend":item.get("middle_term_trend"),
            "has_options":      item.get("has_options"),
        }
        for item in data[:limit]
    ]


@mcp.tool()
def list_all_stocks(
    page: int = 1,
    per_page: int = 50,
) -> list:
    """List ALL stocks on B3 with pagination (includes those without options).

    Args:
        page: Page number (default 1).
        per_page: Results per page (default 50).

    Returns:
        List of all stocks with symbol, name, price, and volume.
    """
    data = _get("/stocks/all", {"page": page, "per": per_page}) or []
    return data if isinstance(data, list) else []


@mcp.tool()
def get_stock_details(symbol: str) -> dict:
    """Get full details for a specific stock including financials.

    Args:
        symbol: Ticker symbol, e.g. PETR4, VALE3.

    Returns:
        Dict with stock price, analytics, and financial data.
    """
    d = _get(f"/stocks/{symbol.upper()}")
    return d or {}


# ===========================================================================
# 3. OPÇÕES
# ===========================================================================

@mcp.tool()
def get_options_chain(symbol: str) -> list:
    """Get the complete options chain (all CALLs and PUTs) for a stock.

    PETR4 alone has ~3,500 listed contracts across all expiry dates.

    Args:
        symbol: Underlying stock ticker, e.g. PETR4, VALE3, ITUB4.

    Returns:
        List of option contracts with symbol, category (CALL/PUT), strike,
        due_date, days_to_maturity, close, bid, ask, volume, and IV.
    """
    data: list = _get(f"/options/{symbol.upper()}") or []
    return [
        {
            "symbol":           opt.get("symbol"),
            "underlying":       symbol.upper(),
            "category":         opt.get("category"),
            "strike":           opt.get("strike"),
            "due_date":         opt.get("due_date"),
            "days_to_maturity": opt.get("days_to_maturity"),
            "maturity_type":    opt.get("maturity_type"),
            "close":            opt.get("close"),
            "open":             opt.get("open"),
            "high":             opt.get("high"),
            "low":              opt.get("low"),
            "bid":              opt.get("bid"),
            "ask":              opt.get("ask"),
            "volume":           opt.get("volume"),
            "financial_volume": opt.get("financial_volume"),
            "iv_current":       opt.get("iv_current"),
            "spot_price":       opt.get("spot_price"),
        }
        for opt in data
    ]


@mcp.tool()
def get_option_details(symbol: str) -> dict:
    """Get detailed data for a single option contract.

    Args:
        symbol: Option ticker symbol, e.g. PETRE344W4, VALEF340.

    Returns:
        Dict with full option data: price, Greeks, IV, volume, open interest.
    """
    return _get(f"/options/details/{symbol.upper()}") or {}


@mcp.tool()
def get_covered_call_options(symbol: str) -> list:
    """Get options suitable for covered call (or cash-secured put) strategies.

    Args:
        symbol: Underlying stock you own, e.g. PETR4, VALE3.

    Returns:
        List of options ranked by suitability for covered call writing.
    """
    data = _get("/options/strategies/covered", {"symbol": symbol.upper()}) or []
    return data if isinstance(data, list) else []


@mcp.tool()
def get_popular_options() -> list:
    """Get the most actively traded options ("pós" / powders) on B3 today.

    No parameters required.

    Returns:
        List of popular options with symbol, close, strike, variation, and volume.
    """
    data = _get("/options/powders") or []
    return data if isinstance(data, list) else []


@mcp.tool()
def calculate_black_scholes(
    symbol: str,
    strike: float,
    expiration: str,
    option_type: str,
    volatility: float,
    interest_rate: float,
    dividend_yield: float = 0.0,
) -> dict:
    """Calculate the Black-Scholes theoretical price for an option.

    Args:
        symbol: Underlying stock ticker, e.g. PETR4.
        strike: Strike price, e.g. 44.0.
        expiration: Expiration date in YYYY-MM-DD format.
        option_type: "CALL" or "PUT".
        volatility: Implied volatility as a decimal, e.g. 0.33 for 33%.
        interest_rate: Risk-free rate as a decimal, e.g. 0.1475 for 14.75% (SELIC).
        dividend_yield: Dividend yield as a decimal, e.g. 0.05 for 5% (default 0).

    Returns:
        Dict with theoretical price and Greeks (delta, gamma, theta, vega, rho).
    """
    params = {
        "symbol":        symbol.upper(),
        "strike":        strike,
        "expiration":    expiration,
        "option_type":   option_type.upper(),
        "volatility":    volatility,
        "interest_rate": interest_rate,
        "dividend_yield":dividend_yield,
    }
    return _get("/options/bs", params) or {}


# ===========================================================================
# 4. DADOS HISTÓRICOS
# ===========================================================================

@mcp.tool()
def get_historical_candles(
    symbol: str,
    resolution: str = "1d",
    amount: int = 252,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
) -> dict:
    """Get historical OHLCV candlestick data for a stock.

    Args:
        symbol: Ticker symbol, e.g. PETR4, VALE3.
        resolution: Candle interval:
            "1"  → 1 minute  |  "5"  → 5 minutes  |  "15" → 15 minutes
            "30" → 30 minutes  |  "60" → 1 hour
            "1d" → daily (default)  |  "1w" → weekly  |  "1M" → monthly
        amount: Number of candles to return (default 252 = ~1 trading year).
        from_date: Optional start date in YYYY-MM-DD format.
        to_date: Optional end date in YYYY-MM-DD format.

    Returns:
        Dict with keys: symbol, name, resolution, data (list of OHLCV candles).
        Each candle has: time, open, high, low, close, volume.
    """
    params: dict = {"amount": amount}
    if from_date:
        params["from"] = from_date
    if to_date:
        params["to"] = to_date
    return _get(f"/historical/{symbol.upper()}/{resolution}", params) or {}


@mcp.tool()
def get_options_historical_range(
    symbol: str,
    from_date: str,
    to_date: str,
) -> list:
    """Get historical data for all options on a stock within a date range.

    Useful for backtesting, studying IV evolution, and historical P&L analysis.

    Args:
        symbol: Underlying stock ticker, e.g. PETR4, VALE3.
        from_date: Start date in YYYY-MM-DD format.
        to_date: End date in YYYY-MM-DD format.

    Returns:
        List of option data points with symbol, time, spot price, type, and due_date.
    """
    data = _get(f"/historical/options/{symbol.upper()}/{from_date}/{to_date}") or []
    return data if isinstance(data, list) else []


# ===========================================================================
# 5. RANKINGS E ESTATÍSTICAS
# ===========================================================================

@mcp.tool()
def get_ranking_by_attribute(
    attribute: str,
    sort: str = "DESC",
    limit: int = 20,
    page: int = 1,
    sector: Optional[str] = None,
) -> list:
    """Get stocks ranked by a fundamental or quantitative attribute.

    Args:
        attribute: Field to rank by. Common values:
            "oplab_score"  — OpLab proprietary score (recommended)
            "m9_m21"       — MA9 vs MA21 technical trend
            "correl_ibov"  — Correlation with Ibovespa
            "iv_current"   — Current implied volatility
            "ewma_current" — Current EWMA volatility
            "semi_return_1y" — 1-year semi-return
            "entropy"      — OpLab entropy indicator
        sort: "DESC" (highest first) or "ASC" (lowest first).
        limit: Maximum results (default 20).
        page: Page for pagination (default 1).
        sector: Optional sector filter, e.g. "PETRÓLEO E GÁS".

    Returns:
        List of ranked stocks with symbol, attribute value, and metadata.
    """
    params: dict = {"sort": sort, "limit": limit, "page": page}
    if sector:
        params["sector"] = sector
    data = _get(f"/statistics/ranking/{attribute}", params) or []
    return data if isinstance(data, list) else []


@mcp.tool()
def get_oplab_score_ranking(
    sort: str = "DESC",
    limit: int = 20,
    sector: Optional[str] = None,
) -> list:
    """Get stocks ranked by OpLab's proprietary composite score.

    The OpLab score combines earnings growth, revenue, cash position,
    liabilities, and technical momentum signals.

    Args:
        sort: "DESC" for highest scores first, "ASC" for lowest.
        limit: Maximum results (default 20).
        sector: Optional sector filter.

    Returns:
        List of stocks sorted by OpLab score with symbol, name, score, and sector.
    """
    params: dict = {"sort": sort, "limit": limit}
    if sector:
        params["sector"] = sector
    data = _get("/statistics/ranking/oplab_score", params) or []
    return data if isinstance(data, list) else []


@mcp.tool()
def get_trending_options(
    sort: str = "DESC",
    limit: int = 20,
) -> list:
    """Get stocks with the strongest short-term technical trends (MA9 vs MA21).

    Args:
        sort: "DESC" for strongest uptrends, "ASC" for strongest downtrends.
        limit: Maximum results (default 20).

    Returns:
        List of stocks with trend strength, symbol, and name.
    """
    params = {"sort": sort, "limit": limit}
    data = _get("/statistics/ranking/m9_m21", params) or []
    return data if isinstance(data, list) else []


@mcp.tool()
def get_ibov_correlation_ranking(
    sort: str = "DESC",
    limit: int = 20,
) -> list:
    """Get stocks ranked by their correlation coefficient with the Ibovespa index.

    Args:
        sort: "DESC" for highest correlation first, "ASC" for lowest (inverse).
        limit: Maximum results (default 20).

    Returns:
        List of stocks with correlation coefficient, symbol, and name.
    """
    params = {"sort": sort, "limit": limit}
    data = _get("/statistics/ranking/correl_ibov", params) or []
    return data if isinstance(data, list) else []


@mcp.tool()
def get_best_covered_call_rates(
    option_type: str = "CALL",
    limit: int = 20,
) -> list:
    """Get options with the best annualized yield for covered call/put strategies.

    Args:
        option_type: "CALL" for covered calls, "PUT" for cash-secured puts.
        limit: Maximum results (default 20).

    Returns:
        List of options sorted by annualized return with symbol, due_date,
        profit_rate_if_exercised, and financial_volume.
    """
    data = _get(f"/statistics/realtime/best_covered_options_rates/{option_type.upper()}", {"limit": limit}) or []
    return data if isinstance(data, list) else []


@mcp.tool()
def get_highest_option_variations(
    option_type: str = "CALL",
    limit: int = 20,
) -> list:
    """Get options with the largest price movements today.

    Args:
        option_type: "CALL" or "PUT".
        limit: Maximum results (default 20).

    Returns:
        List of options sorted by absolute price change today.
    """
    data = _get(f"/statistics/realtime/highest_options_variation/{option_type.upper()}", {"limit": limit}) or []
    return data if isinstance(data, list) else []


@mcp.tool()
def get_highest_option_volume(limit: int = 20) -> list:
    """Get the options with the highest trading volume today.

    No option_type filter — returns both CALLs and PUTs.

    Args:
        limit: Maximum results (default 20).

    Returns:
        List of options sorted by trading volume with call, put, and total volume.
    """
    data = _get("/statistics/realtime/highest_options_volume", {"limit": limit}) or []
    return data if isinstance(data, list) else []


# ===========================================================================
# 6. BOLSAS DE VALORES
# ===========================================================================

@mcp.tool()
def list_exchanges() -> list:
    """List all stock exchanges available on OpLab (B3, BCB, etc.).

    No parameters required.

    Returns:
        List of exchanges with uid, name, opening time, and closing time.
    """
    data = _get("/exchanges") or []
    return data if isinstance(data, list) else []


@mcp.tool()
def get_exchange_details(uid: str) -> dict:
    """Get details for a specific stock exchange.

    Args:
        uid: Exchange identifier, e.g. "BVMF" (B3/Bovespa), "BCB".

    Returns:
        Dict with exchange name, trading hours, and current status.
    """
    return _get(f"/exchanges/{uid.upper()}") or {}


# ===========================================================================
# 7. COMPANHIAS
# ===========================================================================

@mcp.tool()
def get_companies_info(symbols: str) -> list:
    """Get corporate information for one or more companies.

    Args:
        symbols: Comma-separated ticker symbols, e.g. "PETR4,VALE3,ITUB4".

    Returns:
        List of company dicts with CNPJ, sector, IPO date, and other corporate data.
    """
    data = _get("/companies", {"symbols": symbols.upper()}) or []
    return data if isinstance(data, list) else [data]


# ===========================================================================
# 8. TAXAS DE JUROS
# ===========================================================================

@mcp.tool()
def list_interest_rates() -> list:
    """List all available interest rates tracked by OpLab (SELIC, CDI, etc.).

    No parameters required.

    Returns:
        List of interest rates with uid, name, current value, and last updated time.
    """
    data = _get("/interest_rates") or []
    return data if isinstance(data, list) else []


@mcp.tool()
def get_interest_rate(rate_id: str) -> dict:
    """Get detailed information for a specific interest rate.

    Args:
        rate_id: Rate identifier, e.g. "SELIC", "CDI".

    Returns:
        Dict with rate name, current value (as a decimal), and last updated time.
    """
    return _get(f"/interest_rates/{rate_id.upper()}") or {}


# ===========================================================================
# 9. STATUS DO MERCADO
# ===========================================================================

@mcp.tool()
def get_market_status() -> dict:
    """Get the current market status — whether B3 is open or closed.

    No parameters required.

    Returns:
        Dict with server_time and market_status (OPEN / CLOSED / PRE_OPEN / etc.).
    """
    return _get("/status") or {}


# ===========================================================================
# Entry point
# ===========================================================================

def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
