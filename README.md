# あいもげ あにまん風UI

[![Tampermonkeyにインストール](https://img.shields.io/badge/Tampermonkey-%E3%82%A4%E3%83%B3%E3%82%B9%E3%83%88%E3%83%BC%E3%83%AB-104cd0?style=for-the-badge)](https://raw.githubusercontent.com/nijiurachan/aimoge-animanch-theme/main/aimoge-animanch-theme.user.js)

あいもげの総合カタログとスレッドを、あにまん掲示板風に表示するTampermonkey用スクリプトです。
作者：official-aimg ／ ライセンス：[MIT](LICENSE) ／ バージョン：2.0.0

## インストール方法

GitHubのアカウントやプログラミングの知識は不要です。
すでにTampermonkeyの初期設定が済んでいる場合は、手順2から進めてください。

1. [あいもげWikiの「拡張機能導入方法」](https://wiki.nijiurachan.net/694d533a1396282abd0f70b2)を開き、使用するブラウザーの初期設定を済ませます。Chromeでは「ユーザー スクリプトを許可する」をオンにしてください。
2. このページ上部の「インストール」ボタン、または[スクリプトのインストールリンク](https://raw.githubusercontent.com/nijiurachan/aimoge-animanch-theme/main/aimoge-animanch-theme.user.js)を、同じブラウザーで開きます。
3. Tampermonkeyの確認画面で、名前が「あいもげ総合カタログ あにまん風UI」、作者が「official-aimg」であることを確認し、「インストール」を押します。
4. [あいもげの総合カタログ](https://nijiurachan.net/mix/)を開きます。すでに開いていた場合は、ページを再読み込みします。

Chromeで実行許可の項目が見つからない場合や、別のブラウザーを使う場合は、[Tampermonkey公式の導入先](https://www.tampermonkey.net/)と[実行許可の案内](https://www.tampermonkey.net/faq.php?q=Q209)も参照できます。

青いヘッダーと「更新順・新着・人気・過疎・シャッフル・板」のメニューが表示されれば、適用できています。

### Androidで使う場合

Android版Firefoxには[Tampermonkeyの導入先](https://addons.mozilla.org/ja/firefox/addon/tampermonkey/)があります。
Firefox内でTampermonkeyを追加し、同じFirefoxで上記のインストールリンクを開いてください。
Chrome用の実行許可設定はFirefoxでは不要です。

スマートフォンの画面は仮想Androidで確認していますが、Android版FirefoxとTampermonkeyの組み合わせでの本テーマの実動作は未確認です。

### iPhoneで使う場合

iPhone・iPadでは、Safari用の[Tampermonkeyアプリ](https://apps.apple.com/jp/app/tampermonkey/id6738342400)を使って導入します。
アプリは有料です。購入前にApp Storeで価格と対応OSを確認してください。本テーマのスクリプト自体は無料です。
以下は導入方法の案内であり、iPhone・iPadでの本テーマの実動作は未確認です。

1. App Storeから「Tampermonkey」をインストールします。開発元が「Jan Biniok」であることを確認し、インストール後にアプリを一度開きます。
2. iPhoneの「設定」で「アプリ」「Safari」「機能拡張」の順に開き、「Tampermonkey」の「機能拡張を許可」をオンにします。「アプリ」がない場合は、設定内で「Safari」を探してください。
3. Safariで[スクリプトのインストールリンク](https://raw.githubusercontent.com/nijiurachan/aimoge-animanch-theme/main/aimoge-animanch-theme.user.js)を開きます。GitHubやSNSのアプリ内ブラウザーで開いた場合は、リンクをコピーしてSafariのアドレス欄に貼り付けてください。
4. Tampermonkeyからサイトへのアクセス許可を求められたら、インストール元の `raw.githubusercontent.com` へのアクセスを許可します。
5. 確認画面でスクリプト名「あいもげ総合カタログ あにまん風UI」と作者「official-aimg」を確認し、「インストール」を押します。コードだけが表示される場合は、Safariのアドレス欄のページメニューから「Tampermonkey」を開き、下の「インストール画面が出ないとき」にある手動追加を行ってください。
6. 同じSafariで[あいもげの総合カタログ](https://nijiurachan.net/mix/)を開きます。Tampermonkeyの `nijiurachan.net` へのアクセスを許可し、ページを再読み込みします。

Tampermonkeyのメニューが見つからない場合は、Safariのページメニューにある「機能拡張を管理」で有効か確認してください。
Safariのプロファイルを使い分けている場合は、あいもげを開くプロファイルでも有効にします。
設定の詳しい説明は[Apple公式のSafari機能拡張ガイド](https://support.apple.com/en-ie/guide/iphone/iphab0432bf6/ios)、配布元は[Tampermonkey公式のSafari向けページ](https://www.tampermonkey.net/index.php?browser=safari&locale=ja)で確認できます。

### インストール画面が出ないとき

コードだけが表示される場合は、Tampermonkeyが有効か、スクリプトの実行を許可したかを確認してください。
アプリ内ブラウザーではなく、Tampermonkeyをインストールしたブラウザーでリンクを開きます。

手動で追加することもできます。

1. [スクリプトのコード](https://raw.githubusercontent.com/nijiurachan/aimoge-animanch-theme/main/aimoge-animanch-theme.user.js)を開き、全文をコピーします。
2. Tampermonkeyのメニューから「新規スクリプトを追加」を開き、最初から入っているコードをすべて置き換えます。
3. エディターの保存操作で保存し、総合カタログを再読み込みします。

表示が変わらない場合は、Tampermonkeyの管理画面で本スクリプトが有効か、開いているURLが `https://nijiurachan.net/mix/` 配下かを確認してください。
個別板の `/b/` 画面には適用しません。

## できること

- ヘッダー、開閉メニュー、カタログ、スレッドをあにまん風の配置に変更します。
- 「過疎」は取得対象全体を勢いの昇順に、「シャッフル」は全体をランダムに並べます。
- 所属表示に総合・板名・タグ・スレッド名を表示します。R18タグはこの所属表示から省きます。
- ハートに「そうだね」の値を使い、数が増えた書き込みを強調します。
- レス番号を押すと、その書き込みのNo.返信を返信欄に追加します。
- 「報告」から元のdel操作を呼び出します。
- 投稿、認証、添付、画像のぼかし、名前表示の板設定は、あいもげの既存機能を使います。

## 更新・停止

更新の取得先はこのリポジトリです。Tampermonkeyの更新設定に従って更新を確認します。
手動で更新する場合は、インストールリンクを開き、Tampermonkeyの確認画面で更新します。
作者・名前・namespaceを維持しているため、以前の手動導入版にも同じスクリプトとして更新できます。

元の表示に戻す場合は、Tampermonkeyの管理画面でこのスクリプトを無効にし、あいもげを再読み込みしてください。

## 動作確認と差異

LinuxのChromeとTampermonkeyで実動作を確認し、描画・操作・並び替えの関連テスト41件が成功しています。
スマートフォン表示は仮想AndroidのChromeで、画面幅393pxのあにまんのカタログ・スレッドと比較しています。
Androidの確認はスクリプトの一時実行によるもので、Android上のTampermonkeyによる確認ではありません。

あにまんとあいもげでは機能が異なるため、返信欄はあいもげのシート形式を保持します。
あにまん独自のおすすめ枠やスレッドお気に入り登録・共有は含めません。
あにまんのロゴや投稿データは配布ファイルに含めません。

不具合は[Issues](https://github.com/nijiurachan/aimoge-animanch-theme/issues)へ、ブラウザー名・画面幅・問題が起きた操作を添えて報告してください。
