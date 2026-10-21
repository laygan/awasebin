# あわせ便

仲間内でコスプレ写真を共有するための、招待・パスキー限定のWebアプリです。[システム仕様書](システム仕様書.md)に基づく初期実装です。

**現在の状態：未配備・受入未完了。** ソースを実装しましたが、この作業環境では依存取得が承認されなかったため、ビルド・DB統合試験・実ブラウザ試験は未実行です。100GB以上のP2P対応を保証する状態ではありません。P2Pは初期値 `P2P_ENABLED=false` です。[検証記録](docs/acceptance.md)を参照してください。

## 構成

- `web/`：React / TypeScript。写真セット、アップロード一時停止・再開、招待登録、パスキー管理、管理画面、匿名共有、規約。
- `server/`：Fastify / PostgreSQL、SimpleWebAuthn、tusdフック、検証キュー、HTTP Range配信、認可付きWebSocketトラッカー、WebTorrentシーダー、定期削除。
- `deploy/`：単一Linux VM用Nginx・systemd・logrotate設定。コンテナは使いません。
- `tests/`：依存不要のセキュリティテストと、PGlite（PostgreSQL WASM）によるAPI統合テスト。

## 開発起動

必要環境：Node.js 22.12以上、PostgreSQL、tusd v2、Nginx。WebAuthnはHTTPSまたはlocalhostの安全なコンテキストで使用してください。本番はDebian VMを想定し、Windowsはフロント・API開発向けです。

```powershell
Copy-Item .env.example .env
# .env の DATABASE_URL、TOKEN_SECRET、INTERNAL_SECRET を編集
npm install
npm run migrate
npm run bootstrap -- 管理者名
npm run prepare:browser
npm run dev:api
```

別ターミナルで `npm run dev` を起動し、`http://localhost:5173` を開きます。ブートストラップコマンドが出力する1時間有効の単回リンクで管理者パスキーを登録します。初期管理者作成後の再ブートストラップは禁止されます。サインイン画面で偽のデモアカウントを使う仕組みはありません。

アップロードにはtusdと認可を仲介するNginxが必要です。Viteの `/uploads` も本番と同じ認可ゲートを通す必要があります。詳しくは[VM配備手順](docs/deployment.md)を参照してください。開発時にtusdのポートを外部へ公開しないでください。

```text
npm test
npm run build
```

依存なしで実行できる確認：`node --test tests/security.test.mjs`。

## 実装上の方針

招待・共有・セッション・アップロード権限は256bit乱数とし、DBにはSHA-256ハッシュを保存します。WebAuthnチャレンジは5分有効・単回使用、ユーザー検証必須。パスワード・OTP・自主登録はありません。Cookieセッションは本番でSecure / HttpOnly / SameSite Strictです。状態変更はOriginとCSRFを検証します。

アップロード前にブラウザのWorkerで4MiBずつSHA-256を計算し、サイズ・期待ハッシュに紐付いた権限を発行します。tusdによる16MiBチャンク転送後、サーバがストリーミング検証し、元ファイルを移動します。アップロード途中の予約量を含めて容量を制御します。検証失敗した写真は公開できません。セットごと削除して再送してください。権限は最大24時間有効で、期限後の部分ファイルは削除します。

ブラウザの中断再開情報は同一端末のlocalStorageに保存します。再開時は同じセットで同じファイルを選びます。ファイルは再ハッシュしますが、転送位置はtus HEAD応答を正として再開します。

HTTP配信は通常のブラウザ保存とRangeに対応し、全量Blobを生成しません。配信中も1秒ごとに共有状態を確認し、公開停止・期限切れでストリームを閉じます。共有URLを再表示するための平文保管はしないため、発行直後にリンクを保管してください。

P2PはプライベートTorrent、DHT/LSD/PEX無効、サーバシードと受信者間だけのシグナリングです。接続権限は5分以内の新規参加用で、成立済みの転送はセットの期限まで継続できます。シーダーは認可されたpeer IDのWebRTC接続のみ配信し、受信者同士は紹介しません。TURNは提供せず、接続失敗・非対応ブラウザ・容量不足にはHTTP取得を案内します。

ブラウザP2Pの受信ピースはIndexedDBに保存し、完了後にFile System Access APIでファイル単位に逐次書き込みます。保存時にSHA-256も照合します。ブラウザ一時領域と保存先の双方に十分な空き容量が必要です。重複名対策で保存名にはファイルIDの先頭8文字を付けます。再読込後のピース再利用、ブラウザの保存上限、長時間メモリ使用量は未検証です。個別HTTP取得はそのまま利用できます。

プレビューはsharpを子プロセスで実行し、15秒で停止します。40MPを超える画像や未対応RAWにはプレビューを生成しません。元ファイルは保存し、プレビューからのみEXIFを除去します。

## 未確定事項

実ドメイン、TLS証明書、IPv4/IPv6到達経路、VyOS/FW、Cloudflare設定、写真バックアップ、通報連絡先は運用環境で設定が必要です。VMやDNSをこのリポジトリから自動作成する処理は含めません。Cloudflare Workersではこの常駐WebRTC・PostgreSQL・ローカル保存構成をそのまま運用できないため、Sitesへの公開は行いません。

Node依存のネイティブWebRTC実装、トラッカー相互運用、100〜200GBの転送と保存について、仕様書16章のPoCを終えるまで本番公開しないでください。HTTPのレート制限は現状アプリが見る接続元（Nginx）単位で共通です。入口Nginxでは実接続元ごとに制御します。Cloudflareを併用する場合の実IP復元は信頼する送信元ネットワークを限定して設定してください。

容量・保持期間・同時アップロード数・同時P2P接続数・セッション期間は管理画面で変更でき、DBへ保存して各サービスに反映します。P2Pは環境変数での許可も必要です。HTTP/P2Pの24時間転送量を管理画面に表示します。ヘルス監視と暗号化メタデータバックアップ用のsystemdタイマーを同梱しています。TURN費用計測・課金上限、ICE接続候補の収集・統計ダッシュボードは未実装です。運用設定と受入が必要な項目は[検証記録](docs/acceptance.md)に明記しています。

## 技術参照

- [SimpleWebAuthn Server](https://simplewebauthn.dev/docs/packages/server)
- [tusd Hooks](https://tus.github.io/tusd/advanced-topics/hooks/)
- [tusd Configuration](https://tus.github.io/tusd/getting-started/configuration/)
- [WebTorrent API](https://webtorrent.io/docs)
- [WebTorrent 2.8.5 source](https://github.com/webtorrent/webtorrent/tree/v2.8.5)
