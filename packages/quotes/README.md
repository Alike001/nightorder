# Market quotes

`createBinanceSpotMarketDataPort` reads the public BTCUSDT best bid and ask from Binance Spot's market-data-only REST API:

`https://data-api.binance.vision/api/v3/ticker/bookTicker?symbol=BTCUSDT`

The endpoint payload includes string values for `bidPrice` and `askPrice`, but it does not include an exchange event timestamp. The adapter samples `observedAtUtc` after receiving and parsing the response, so `observedAtUtc` equals `receivedAtUtc`. Freshness checks measure age since this worker received the response; they cannot establish the age of the exchange's underlying book data before delivery.

The adapter accepts injected fetch and clock functions so tests can validate payloads and timeout behavior without fabricating a live quote.
