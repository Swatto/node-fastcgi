# Changelog

## [0.1.3](https://github.com/Swatto/node-fastcgi/compare/v0.1.2...v0.1.3) (2026-04-30)


### Performance Improvements

* **hot-path:** six targeted allocations and copy eliminations ([ee644a0](https://github.com/Swatto/node-fastcgi/commit/ee644a0c74efbbbee29802e8d6b64e90de225fed))

## [0.1.2](https://github.com/Swatto/node-fastcgi/compare/v0.1.1...v0.1.2) (2026-04-30)


### Bug Fixes

* **connection,response:** prevent duplicate END_REQUEST on late ABORT_REQUEST ([2c2b351](https://github.com/Swatto/node-fastcgi/commit/2c2b3513f26cb76ec55a1ad2770f29121fee9506))
* **connection:** advertise honest FCGI_MAX_CONNS / FCGI_MAX_REQS ([3254b3f](https://github.com/Swatto/node-fastcgi/commit/3254b3f90dff8d55df7677b33821751183aa9812))
* **connection:** buffer STDIN that arrives before the PARAMS terminator ([1016616](https://github.com/Swatto/node-fastcgi/commit/1016616aa9a966312142baa4a2095ab6ba3de470))
* **connection:** ignore PARAMS records received after the empty terminator ([d6b8231](https://github.com/Swatto/node-fastcgi/commit/d6b8231753b921a3632aea6b9d916e863da78734))
* **record:** bound RecordParser internal buffering to prevent slowloris OOM ([9337b7f](https://github.com/Swatto/node-fastcgi/commit/9337b7f31a5311058695366fe6fbbaa96a212f07))
* **request:** preserve Content-Length: 0 and tighten HTTPS scheme heuristic ([4829ddf](https://github.com/Swatto/node-fastcgi/commit/4829ddffbabfc8cc766f7376f6a5a9fde42f35f1))
* **response:** always use Headers.getSetCookie() for Set-Cookie headers ([04a1b93](https://github.com/Swatto/node-fastcgi/commit/04a1b93e7e09f4074b51cecb224c4ba10c31d3ab))
* **response:** cancel body stream reader when writing fails or request ends early ([9715677](https://github.com/Swatto/node-fastcgi/commit/9715677cad1325b5a1c5d576728bfe0a7689f68d))
* **response:** writeStderr emits nothing for an empty message ([903da4d](https://github.com/Swatto/node-fastcgi/commit/903da4df82aa46c482cc7318f22c450828b58bc9))


### Performance Improvements

* **serve:** enable TCP_NODELAY on accepted TCP connections ([7b699b7](https://github.com/Swatto/node-fastcgi/commit/7b699b760894dc0e4d2dc5715cadee1c8af2638a))

## [0.1.1](https://github.com/Swatto/node-fastcgi/compare/v0.1.0...v0.1.1) (2026-04-30)


### Bug Fixes

* reject serve() when multiple transport options are specified ([ac1cb0c](https://github.com/Swatto/node-fastcgi/commit/ac1cb0c8ca3c4f263a010050b31c6638d695f088))
