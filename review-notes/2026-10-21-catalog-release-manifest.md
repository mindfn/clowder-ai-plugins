# configurationVariants 发布候选清单

状态：源码 PR #101 待验证与审阅，未发布、未激活 live catalog。

## 范围

- contract 0.2.0：新增配置分支模型与共享解析；`contractVersion` 是插件所需协议，不等同于 npm 依赖版本。
- SDK 0.2.0-beta.24：支持新契约。beta.23 已发布，其他插件继续使用自己的声明版本。
- connector-feishu 0.1.0-alpha.8：Verification Token 仅属于 Webhook 分支。
- video-generation 0.1.0-alpha.2：认证字段按 authType 分支选择。
- 通用依赖兼容校验另行交付；不批量升级其他插件。

## 候选制品

使用 Node 24.18.0 / npm 11.16.0，先构建再运行原 `scripts/pack-publish-artifact.mjs`；没有新增解包重压缩逻辑。下表等待同 HEAD Ubuntu CI 的制品一致性验收。

| 包 | 版本 | 字节 | SHA256 |
|---|---|---:|---|
| plugin-contract | 0.2.0 | 233868 | `9f8d97bc63647301036cb7b1f37310332cc02b20879352d37fe9c5217bf9c739` |
| plugin-sdk | 0.2.0-beta.24 | 92488 | `06ef52010accb1e9a670df040ccff7258e585c6256d2fcded7afe17244e58e31` |
| connector-feishu | 0.1.0-alpha.8 | 86603 | `3ec97c208c01e2895c12d63f59585aadbb541a81abd6806f56fa20033ca97dd7` |
| video-generation | 0.1.0-alpha.2 | 47195 | `07ab11078933f2e709f5f610a99577adf6440c3872f000be835897eb20cad7ab` |

### 完整 npm integrity

- plugin-contract@0.2.0: `sha512-iFhuTFs/ol09W3n5iF583LuFaLGBQ8nBkdaGrntILSf6Zk40ghKU+lFw1uo97z/NUddoZLDp6x+rkGlHsPYbJg==`；SHA1 `cadcf79b6dbef0a83c1580978479b079774964b7`
- plugin-sdk@0.2.0-beta.24: `sha512-obnziD7d+OHHjQp3eNUKHeZJU5CZ1NC5yonWAak4koXX+Jg8o8wzld3CcBhfGMbZCghIvCFJuXMMTXhNjx7u+g==`；SHA1 `64cdb7002f4e7abca5d30356a8244ffe123b7aad`
- connector-feishu@0.1.0-alpha.8: `sha512-4pwW46+VH7FTSAMaSsw6oNdKbPgQ5hUKLOr9EKmSFSAJMeRfRZjOGBTA/8wDHPglabTAVMRcoeKWPQ+23TZtyw==`；SHA1 `d85d823abe99460238681b4b565cfe7d0c670da2`
- video-generation@0.1.0-alpha.2: `sha512-/xbqkgYvby+8zPLJT2IGXN1ANgl9TnWd4G5MXo1hGM14sWRWwrGS0UB0EDhugu6GGx7MuxntZBFOqFGPMRT3kA==`；SHA1 `6cb3b7a51bc91a4f05a1fc32d21c9c7f3f3c6ada`

契约包位于 `packages/plugin-contract/clowder-ai-plugin-contract-0.2.0.tgz`；SDK/契约哈希必须与飞书 shrinkwrap 完全相同。两个插件的 candidate 条目必须与官方打包结果完全相同。已发布版本的条目不重写。

## 验证与顺序

飞书隔离 registry 安装已验证正式 tgz、保留包内 resolved 路径的 npm ci、错误 SDK/契约下载地址 E404 拒绝、integrity、manifest 校验、create 入口及 EINTEGRITY 篡改拒绝；整套 gate 与云端结果以精确提交的检查为准。

1. Host 通用逻辑在 Host 线程集成，最终 vendor 须绑定本清单经审阅的契约字节。
2. 插件源码 PR 合入一次，main CI 发布；遵守 CODEOWNER 与发布权限约束。
3. 验证 registry 实发的四个版本与字节，另提 catalog activation PR。
4. operator 自行更新重启 Host，通过目录安装验收；运行实例不由猫自动重启。
5. Host 上游合入由 Host owner 按验收结果推进。

旧候选 alpha.6、SDK beta.22 和重压缩路径的 379b0476…制品均不作为本轮交付坐标。不要安装历史 feishu-hotfix-artifacts。
