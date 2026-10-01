# Changelog

## [0.3.0](https://github.com/sebastian-software/harness-relay/compare/v0.2.0...v0.3.0) (2026-10-01)


### Features

* **claude:** continue sessions through a forked resume ([c115c6d](https://github.com/sebastian-software/harness-relay/commit/c115c6d58e527994da84ae19ab74650900da0f76))
* **codex:** continue sessions through exec fork ([#173](https://github.com/sebastian-software/harness-relay/issues/173)) ([8aa2bb8](https://github.com/sebastian-software/harness-relay/commit/8aa2bb8c20dfeeabeafb5ad2122cb2d24c16e15f))


### Bug Fixes

* remove the legacy socket fallback and refresh the 0.2.0 docs ([#170](https://github.com/sebastian-software/harness-relay/issues/170)) ([066633e](https://github.com/sebastian-software/harness-relay/commit/066633ee484918343112741b19fbf883aac1f158))

## [0.2.0](https://github.com/sebastian-software/harness-relay/compare/v0.1.0...v0.2.0) (2026-09-29)


### Features

* **adapters:** bind named connections to native contexts ([#158](https://github.com/sebastian-software/harness-relay/issues/158)) ([adba981](https://github.com/sebastian-software/harness-relay/commit/adba981f7264e2d6219ad0caeb98bd863cab876e))
* add local Pi model routes ([#167](https://github.com/sebastian-software/harness-relay/issues/167)) ([196c6eb](https://github.com/sebastian-software/harness-relay/commit/196c6eb63c0b31398c471e6727f6e5bec73f8f4b))
* **connections:** add named native connection routing ([#155](https://github.com/sebastian-software/harness-relay/issues/155)) ([1b69675](https://github.com/sebastian-software/harness-relay/commit/1b696754280ec54c6b3722f610160ffd8e8b431b))
* **connections:** add shared connection management ([#161](https://github.com/sebastian-software/harness-relay/issues/161)) ([dd4f611](https://github.com/sebastian-software/harness-relay/commit/dd4f6117142bdb43cd5f17074c5b7a4b0b4e75b7))
* **dialogue:** add caller-to-delegate dialogue contract ([#157](https://github.com/sebastian-software/harness-relay/issues/157)) ([07fe7b4](https://github.com/sebastian-software/harness-relay/commit/07fe7b4f6c5b821e08a61fff1749a2d9455f7668))
* **grok:** add bounded ACP adapter foundation ([#168](https://github.com/sebastian-software/harness-relay/issues/168)) ([6b738e6](https://github.com/sebastian-software/harness-relay/commit/6b738e604f891a0940ad30af1b4e877bf0d704f8))
* **pi:** add native live steering ([#166](https://github.com/sebastian-software/harness-relay/issues/166)) ([dd16f9c](https://github.com/sebastian-software/harness-relay/commit/dd16f9c2fd56107f0f8f6be24c4ffeda643e7fce))
* **pi:** add supervised private worker foundation ([#159](https://github.com/sebastian-software/harness-relay/issues/159)) ([81f540e](https://github.com/sebastian-software/harness-relay/commit/81f540e7d5558d991d16ad96701a1ba5885d3db1))
* **pi:** support bound native session continuation ([#162](https://github.com/sebastian-software/harness-relay/issues/162)) ([edc6105](https://github.com/sebastian-software/harness-relay/commit/edc6105d6033e1e1664f8a048ac883e78b972b81))


### Bug Fixes

* **ci:** accept generated release manifest formatting ([#169](https://github.com/sebastian-software/harness-relay/issues/169)) ([ad1fb5d](https://github.com/sebastian-software/harness-relay/commit/ad1fb5d358e1e04984b78a16f1eba9f55c69f293))
* **pi:** reject shell-backed runtime configuration ([#164](https://github.com/sebastian-software/harness-relay/issues/164)) ([7a677f3](https://github.com/sebastian-software/harness-relay/commit/7a677f3282905da80f34d268e7ebd02a56f04fc2))

## 0.1.0 (2026-09-16)


### ⚠ BREAKING CHANGES

* the package is published as `harness-relay` instead of `@sebastian-software/agent-bridge`, and it installs a `harness-relay` executable instead of `agent-bridge`.

### Features

* add executable bridge foundation and CI ([5ecfaec](https://github.com/sebastian-software/harness-relay/commit/5ecfaec23456046806b8a92a19e5ad035f469098))
* add one-shot CLI and typed client ([3655a81](https://github.com/sebastian-software/harness-relay/commit/3655a81a829bb5da2cc552189f3aa31e1818027e))
* add one-shot CLI and typed client ([db78621](https://github.com/sebastian-software/harness-relay/commit/db78621ddb0e31f0021f5d1899a6b676b7d86558))
* add qualified Claude and Codex adapters ([42f4014](https://github.com/sebastian-software/harness-relay/commit/42f401490c02805f319dc6d0f5cd7993c46a305e))
* add qualified Claude and Codex adapters ([6940a5e](https://github.com/sebastian-software/harness-relay/commit/6940a5ed02c0247e472dd93a15624a15d9689367))
* add qualified model aliases to adapter manifests ([2473c44](https://github.com/sebastian-software/harness-relay/commit/2473c44fc41befe82847287b13af53245c008a39))
* add user-extensible model catalog ([5e8ca39](https://github.com/sebastian-software/harness-relay/commit/5e8ca39ca57079490b7dee3ec345b4dc2633c36d))
* add user-extensible model catalog ([d70e71c](https://github.com/sebastian-software/harness-relay/commit/d70e71cf615dcbe19f6b1f7f50e6c1b8d518b8e4))
* complete CLI invocation surface ([12cc42e](https://github.com/sebastian-software/harness-relay/commit/12cc42eb3d9b3f0e7ba7c8691a89a2251616ef9a))
* complete CLI invocation surface ([146c9f7](https://github.com/sebastian-software/harness-relay/commit/146c9f7bdbd4689839f71eef7ad41fb55b05790f))
* configure and cache broker runtime ([599d414](https://github.com/sebastian-software/harness-relay/commit/599d414d8a8610e14e88a8592cdcad9ab8eb8bb5))
* configure and cache broker runtime ([3be1e21](https://github.com/sebastian-software/harness-relay/commit/3be1e21b848550b7791b5c2ad9ac0232f3edb03f))
* enforce adapter policy and version ranges ([4d6fe2d](https://github.com/sebastian-software/harness-relay/commit/4d6fe2d1f10ff5d709396cb2717243492ba58ae8))
* enforce adapter policy and version ranges ([6b8eb65](https://github.com/sebastian-software/harness-relay/commit/6b8eb65ac45529643c7d176159dc2ee72fd69b29))
* establish bridge foundation, CI, and fake harness ([f0d7512](https://github.com/sebastian-software/harness-relay/commit/f0d7512cb3864fce2c7557e3aca2994d13b14296))
* harden broker protocol and retention ([7a8244c](https://github.com/sebastian-software/harness-relay/commit/7a8244c6ccce24a903c61f344a00111d1023d73d))
* harden broker protocol and retention ([b20f147](https://github.com/sebastian-software/harness-relay/commit/b20f14779b5e0fa8268aa2454082061b25717657))
* harden effect and invocation persistence ([c3056f5](https://github.com/sebastian-software/harness-relay/commit/c3056f59d090f4fd2e50f081e7919b83de84322c))
* harden effect and invocation persistence ([408b172](https://github.com/sebastian-software/harness-relay/commit/408b172dccf79f83d8770a4fa72a9cf55bd73ad1))
* make adapter output and process handling faithful ([ece8cc7](https://github.com/sebastian-software/harness-relay/commit/ece8cc7d85fcb29f04cb8c31ffe0b7cdd85940fd))
* make adapter output and process handling faithful ([6f1aa3a](https://github.com/sebastian-software/harness-relay/commit/6f1aa3a76a182a57ad289334833ca4e893372eb2))
* make broker shutdown and directories safer ([c2a503c](https://github.com/sebastian-software/harness-relay/commit/c2a503c5f3000d2462d1fbf20a17aa79494ae9f6))
* make broker shutdown and directories safer ([1b9f787](https://github.com/sebastian-software/harness-relay/commit/1b9f787ee17fed3fbf8fe60487103934ac5b1bc1))
* observe in-place workspace effects ([d679384](https://github.com/sebastian-software/harness-relay/commit/d679384573938e8180dbc0ffd1cbe8a49e01bfef))
* observe workspace effects and serialize completeness ([2edfec0](https://github.com/sebastian-software/harness-relay/commit/2edfec047e8472866e96f8544a7860d52b0941b9))
* prepare public 0.1.0 release with installable skills ([#141](https://github.com/sebastian-software/harness-relay/issues/141)) ([ccc695e](https://github.com/sebastian-software/harness-relay/commit/ccc695e2636e47a678d6d817bddcdf53fdb10f40))
* project bridge operations through MCP ([49de78d](https://github.com/sebastian-software/harness-relay/commit/49de78d531901e90133a9221206e1564bb445f8c))
* project bridge operations through MCP ([18ed440](https://github.com/sebastian-software/harness-relay/commit/18ed440723ea669b72a0f104c2aa4d558a442e5b))
* publish qualified canonical model routes ([203cce9](https://github.com/sebastian-software/harness-relay/commit/203cce93675386d3a20284cb92539dc8931d9b49))
* publish versioned invocation schemas ([615ceb4](https://github.com/sebastian-software/harness-relay/commit/615ceb4450b95f8117fc1764507f2e03c6b2d2da))
* publish versioned invocation schemas ([67a7171](https://github.com/sebastian-software/harness-relay/commit/67a71713635ac948b7235cafd762262cc2971b6a))
* rename the tool to harness-relay ([#133](https://github.com/sebastian-software/harness-relay/issues/133)) ([50de2b6](https://github.com/sebastian-software/harness-relay/commit/50de2b62aef336c8a2f651128a0e86d023d8f8ef))
* support Claude orchestrator interactions ([aaaf0e8](https://github.com/sebastian-software/harness-relay/commit/aaaf0e80d517548ece6a5c58912e850e07da797b))
* support Claude orchestrator interactions ([de5ac8d](https://github.com/sebastian-software/harness-relay/commit/de5ac8d2587a442709435ca915186acd42787bcb))


### Bug Fixes

* align contract semantics and workspace effects ([#106](https://github.com/sebastian-software/harness-relay/issues/106)) ([43d5f07](https://github.com/sebastian-software/harness-relay/commit/43d5f07bbbea8690cc0158e45c041dd5c9e7ca1d))
* block parent Claude session environment leakage ([38b3857](https://github.com/sebastian-software/harness-relay/commit/38b3857cd310a23673684d3c3f2fbd5b9c27475b))
* block parent Claude session environment leakage ([745582f](https://github.com/sebastian-software/harness-relay/commit/745582f1673137436a4821e97c627d3362b31b7d))
* clarify startup and interaction evidence ([#116](https://github.com/sebastian-software/harness-relay/issues/116)) ([2194589](https://github.com/sebastian-software/harness-relay/commit/21945890c24b68171601d5e200793acd07aa495b))
* close JSONL readers with child processes ([f62ed08](https://github.com/sebastian-software/harness-relay/commit/f62ed08eb070d57bc8f7bec06e7041e95003b4de))
* confirm Claude effects after tool results ([#115](https://github.com/sebastian-software/harness-relay/issues/115)) ([1b86a38](https://github.com/sebastian-software/harness-relay/commit/1b86a3868b77b676d56d67eb0f84f2c78c649a24))
* expose broker startup diagnostics ([42852c4](https://github.com/sebastian-software/harness-relay/commit/42852c4a9b56cc82d9a450eca70f7025e9ef6cd8))
* expose broker startup diagnostics ([0dd3cc5](https://github.com/sebastian-software/harness-relay/commit/0dd3cc58e7f7a3eb23628c5c834ac87371f638f0))
* handle harness stream errors without crashing ([a0993fc](https://github.com/sebastian-software/harness-relay/commit/a0993fccbf071f3e8d04a091dfa34efe70306f97))
* handle harness stream errors without crashing ([bb6bdf4](https://github.com/sebastian-software/harness-relay/commit/bb6bdf414dfd74986ed0fd4f8427ee256d6fb6ef))
* keep explicit socket overrides compatible ([386427b](https://github.com/sebastian-software/harness-relay/commit/386427ba3bdf639d6018f893643962cdd4969c48))
* let autostarted CLI exit cleanly ([#113](https://github.com/sebastian-software/harness-relay/issues/113)) ([5ef4947](https://github.com/sebastian-software/harness-relay/commit/5ef4947a5c8db11fd3bf47c428949bbc84413ed1))
* make Claude orchestrator mode complete cleanly ([c9a96be](https://github.com/sebastian-software/harness-relay/commit/c9a96bef6a256aaa21b1c210d8a5e124bc14beeb))
* make Claude orchestrator mode complete cleanly ([0e2b6db](https://github.com/sebastian-software/harness-relay/commit/0e2b6db8223371e169409264436c1cc4101ea2de))
* preserve requested model aliases ([#114](https://github.com/sebastian-software/harness-relay/issues/114)) ([3632c0e](https://github.com/sebastian-software/harness-relay/commit/3632c0ed9bf7675c5dea041818aa08f715ff1e6e))
* retain partial invocation results on abort ([c0b12db](https://github.com/sebastian-software/harness-relay/commit/c0b12db0bea268341f2d05fe7941de8833c372b0))
* retain partial invocation results on abort ([6e07334](https://github.com/sebastian-software/harness-relay/commit/6e073348bad50062dc8dc4dd25426f1090819ac4))


### Performance Improvements

* bound invocation store writes and memory ([2ec6ff0](https://github.com/sebastian-software/harness-relay/commit/2ec6ff09b092aca870200a0cd014bfcf2b2b4aca))
* bound invocation store writes and memory ([3095985](https://github.com/sebastian-software/harness-relay/commit/30959854c28c659d955410ba26201b174cd68d17))

## Changelog

All notable changes to this project are documented here. The first public
release is intentionally kept small and local-first.
