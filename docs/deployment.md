# Debian VMへの配備

## 1. VM・ネットワーク

Debian 13、4vCPU、8GB RAM、OS64GB、別データディスク2TB以上を目安にします。`/srv/cosshare` を専用ディスクにマウントし、起動時にもマウントされることを確認します。コンテナを使いません。

443/TCPをIPv4・IPv6の双方から到達可能にしてください。IPv4の直接経路がない場合、IPv4到達可能な大容量HTTPリバースプロキシが必要です。通常のCloudflare TunnelをWebRTCデータの中継経路とは扱いません。管理SSHは管理ネットワークのみ許可します。3000/3001/3002/8080/8081は公開しません。

P2PのUDPポート範囲は採用したネイティブWebRTC実装でPoCを行い、VyOS・VMのファイアウォールで設定します。TCPの通常Torrent配信は使いません。NginxのHTTPS取得経路はIPv4だけの端末で必ず検証します。

## 2. パッケージ・ユーザー・DB

OSの更新後、Node.js 22.12以上、PostgreSQL、Nginx（http_auth_request_module有効）、tusd v2、証明書管理ツール、gettext-baseを管理者が導入します。tusdは公式リリースのチェックサムを確認して `/usr/local/bin/tusd` に配置します。`tusd -help` で同梱ユニットの各フラグを検証してください。

```sh
sudo useradd --system --home-dir /opt/cosshare --shell /usr/sbin/nologin cosshare
sudo install -d -m 0750 -o cosshare -g cosshare /srv/cosshare/{uploads,files,previews,torrents}
sudo install -d -m 0750 -o root -g cosshare /etc/cosshare
sudo install -d -m 0750 -o www-data -g adm /var/log/cosshare
sudo -u postgres createuser --pwprompt cosshare
sudo -u postgres createdb -O cosshare cosshare
```

DB認証情報をシェル履歴に書かず、PostgreSQLをloopbackで待ち受ける設定にします。ソースを `/opt/cosshare` へ配置してください。実行ユーザーにソース変更権限は不要ですが、ビルド担当者には配置・依存導入権限が必要です。

## 3. アプリ設定とビルド

`.env.example` を `/etc/cosshare/app.env` へコピーして編集し、`root:cosshare 0640` にします。値はsystemd EnvironmentFile形式（`KEY=value`）で書きます。

```text
NODE_ENV=production
ORIGIN=https://photos.example.net
RP_ID=photos.example.net
HOST=127.0.0.1
PORT=3000
DATA_ROOT=/srv/cosshare
DATABASE_URL=postgresql://cosshare:YOUR_URL_ENCODED_PASSWORD@127.0.0.1/cosshare
TOKEN_SECRET=独立した32バイト以上の乱数の16進文字列
INTERNAL_SECRET=別の独立した32バイト以上の乱数の16進文字列
TRACKER_URL=wss://photos.example.net/tracker
SEEDER_URL=http://127.0.0.1:3001
P2P_ENABLED=false
STUN_URLS=stun:stun.l.google.com:19302
CONTACT=実際に連絡できる運営窓口
```

秘密値は `openssl rand -hex 32` で個別生成できます。例の文字列や秘密の使い回しを避けてください。tusdの `-max-size` とAPIの `MAX_ALBUM_BYTES` は同じ値に設定します。

```sh
cd /opt/cosshare
npm install
npm test
npm run build
sudo -u cosshare /usr/bin/node --env-file=/etc/cosshare/app.env server/cli.mjs migrate
sudo -u cosshare /usr/bin/node --env-file=/etc/cosshare/app.env server/cli.mjs bootstrap 管理者
```

最初の依存導入で生成される `package-lock.json` をレビューしてリポジトリに保存し、それ以降の配備は `npm ci` を使ってください。現時点では依存取得未実施のためロックファイルはありません。

## 4. Nginxとsystemd

対象ホストのTLS証明書を取得してください。テンプレートの `AWASEBIN_HOST` と `INTERNAL_SECRET` を管理者環境に設定し、その2変数だけを置換します。秘密値をコマンドの引数や履歴に含めず、rootが読める環境ファイルから読み込みます。生成済み設定は秘密を含むため `root:root 0600` にします。

```sh
# root のシェルで実行。app.env は信頼する管理者だけが編集すること。
set -a
. /etc/cosshare/app.env
set +a
AWASEBIN_HOST=photos.example.net
export AWASEBIN_HOST
envsubst '${AWASEBIN_HOST} ${INTERNAL_SECRET}' < deploy/nginx.conf.template > /etc/nginx/conf.d/cosshare.conf
chmod 0600 /etc/nginx/conf.d/cosshare.conf
nginx -t
cp deploy/systemd/* /etc/systemd/system/
cp deploy/logrotate /etc/logrotate.d/cosshare
systemctl daemon-reload
systemctl enable --now cosshare-api cosshare-tracker cosshare-seeder
systemctl reload nginx
systemctl enable --now tusd cosshare-cleanup.timer
```

`nginx -T` は秘密を含む設定を表示するので公開ログに出さないでください。必要な場合は秘密を除去して共有してください。HSTSはホスト構成を確認後に追加します。

同梱NginxはアップロードごとにFastify認可を呼び、全tusリクエストにUpload-Tokenを要求します。tusdのフックはloopbackの8081から秘密を注入しAPIへ送ります。tusd自身を直接公開すると認可ゲートを迂回するため、必ずloopbackのままにしてください。

APIは単一プロセス運用を前提とします。プレビュー処理は子プロセス、入力40MP・15秒制限、V8ヒープ128MBです。native画像デコーダのメモリはV8制限だけでは制限できないため、systemdのサービス全体 `MemoryMax=2G` とあわせて負荷試験してください。アップロード・削除の競合はalbum行ロックで直列化します。

## 5. 起動確認

```sh
curl -fsS http://127.0.0.1:3000/health/ready
systemctl status cosshare-api cosshare-seeder cosshare-tracker tusd cosshare-cleanup.timer
journalctl -u cosshare-api --since today
```

ブートストラップURLを私的なブラウザで開き、管理者登録→招待→アップローダー登録→小さな写真のアップロード→ハッシュ検証→公開準備→公開→匿名取得→失効を確認します。P2Pを無効にした状態ではHTTP配信のみ行います。

## 6. 外部入口・保守

Cloudflareを使うホストではTraining / Search / AgentをすべてBlockに設定し、設定が使えるプラン・現在の機能を確認します。IPv6直結ホストも同じNginx/API保護を適用します。通常ブラウザの匿名取得、AI User-Agent拒否、HEADとRange、中断再開を各入口で試験してください。Cloudflareの接続元IPをそのまま利用者IPと扱わないよう、信頼プロキシ設定を検討します。

写真本体は標準ではバックアップしません。DB・アプリ設定・証明書・Torrent情報を暗号化する `scripts/backup.mjs` と日次タイマーを同梱しています。`age` とPostgreSQLクライアントを導入し、`/var/backups/cosshare` をroot所有0700で作成、`app.env` に `BACKUP_DIR=/var/backups/cosshare` とオフラインで秘密鍵を保管するageの `BACKUP_RECIPIENT=age1...` を設定してから `systemctl enable --now cosshare-backup.timer` で有効化します。DB資格情報はコマンド引数に渡さず、バックアップの平文中間ファイルを作りません。復元にはage秘密鍵が必要です。バックアップを別媒体へ複製し、保持期間と削除手順は運営方針で確定して公開してください。VMスナップショットだけに依存しないでください。

期限切れはAPIで即時拒否し、シーダーは1秒周期で確認、清掃は1分周期で実行します。HTTPの切断確認も1秒周期です。`systemctl enable --now cosshare-health.timer` で1分ごとのreadiness検査を開始できます。失敗通知先は既存監視基盤へ接続してください。ディスク・inode・メモリ・帯域を外部監視に登録し、Node.js・OS・npm依存の定期更新を行います。アクセスログはトークン・IP・URLを記録せず14日、監査は90日、ダウンロード集計は14日保持します。監査ログはDBからアクセス権を限定して確認します。

## 開発時のアップロード

ローカルでもtusdには公開口の認可が必要です。`deploy/nginx-dev.conf.template` の `INTERNAL_SECRET` だけを置換して使用すると、認可ゲートがloopbackの8082、フックブリッジが8081で起動します。Viteの `/uploads` は8082へ接続する設定です。tusdは `-host 127.0.0.1 -port 8080 -base-path /uploads/ -behind-proxy -upload-dir <DATA_ROOT>/uploads -disable-download -disable-termination -max-size 214748364800 -hooks-http http://127.0.0.1:8081/tus-hook -hooks-enabled-events pre-create,post-receive,post-finish` で起動します。開発設定はlocalhost専用であり、本番と同時に有効にしません。

tusdが返すLocationが `http://localhost:5173/uploads/...` になることを確認してください。tusdの8080にViteから直接送る設定はPATCH認証を迂回するため使用しません。
