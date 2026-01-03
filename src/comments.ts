// 体重増加時のコメント（ネガティブ・皮肉多め）
const WEIGHT_GAIN_COMMENTS = [
	'重力との友情が{diff}kg分深まりましたね',
	'お菓子の株主総会、{diff}kg分のお土産付きでしたか',
	'体重計が{diff}kg分の悲鳴を上げています',
	'「食べ放題」の文字に弱いタイプですね',
	'冬眠の準備、順調ですね',
	'成長期はとっくに終わったはずですが',
	'重力に逆らう気はないようで',
	'カロリーゼロ理論、まだ信じてます？',
	'「明日から本気出す」、何回目ですか',
	'体重計との信頼関係が揺らいでいます',
	'おやつは別腹、体重計は正直',
	'着痩せするタイプ、ではなさそうですね',
	'{diff}kgの思い出、増えましたね',
	'食欲の秋が年中続いているようで',
	'ストレス食い、ストレス解消になってます？',
	'体重増加を「成長」と呼ぶのは自由ですが',
	'夜食は記憶に残らなくても体重に残りますよ',
	'運動する時間がない、食べる時間はあるんですね',
	'{diff}kg、立派な自己投資ですね',
	'体重計「また会いましたね」',
	'服のサイズ、そろそろ見直し時では',
	'食べた分だけ幸せ、体重計は不幸せ',
	'胃袋の容量だけは成長し続けていますね',
	'「一口だけ」が積もり積もって{diff}kgですか',
	'代謝が落ちてるのか、食欲が上がってるのか',
	'体重計が悲しそうな目でこちらを見ています',
	'増量成功おめでとうございます（皮肉です）',
	'食事制限という言葉、辞書から消しました？',
	'「水を飲んでも太る」は物理法則に反してますよ',
	'体重が右肩上がり、景気みたいですね（皮肉です）',
];

// 体重減少時のコメント（ポジティブだが上から目線）
const WEIGHT_LOSS_COMMENTS = [
	'やればできる子でしたか。{diff}kg分見直しました',
	'{diff}kg減、まぐれじゃないことを祈ります',
	'体重計が久しぶりに微笑んでいます',
	'おや、本気を出しましたか',
	'この調子で続けられれば、ですけどね',
	'奇跡は続くものではありませんが、期待しておきます',
	'{diff}kg減少、何かあったんですか？（心配）',
	'努力の成果か、たまたまか。次回が楽しみです',
	'体重計「信じていいの…？」',
	'減量成功、油断するとすぐ戻りますよ',
];

// 現状維持のコメント
const WEIGHT_STABLE_COMMENTS = [
	'安定という名の停滞、お見事です',
	'変化を恐れる気持ち、わかりますよ',
	'現状維持も立派な才能です',
	'動かざること山の如し、ですか',
	'測るだけでは痩せませんよ',
	'キープ力だけは認めます',
	'変わらない体重、変わらない生活習慣',
	'安定志向、体重にも表れていますね',
	'「このままでいい」という諦め、感じます',
	'増えてないだけマシ、と思ってませんか',
	'維持するのも大変、増やすのは簡単',
	'変化なし。刺激が足りない人生ですか',
];

// データ不足時のコメント
const NO_DATA_COMMENTS = [
	'測定継続、それだけは偉いです',
	'体重計との対話、本日も継続中ですね',
	'毎日測る。それが大事。痩せるかは別として',
	'継続は力なり、減量は別問題なり',
	'データ収集家としては優秀ですね',
	'測るだけダイエット、効果のほどは…',
];

function getRandomComment(comments: string[]): string {
	return comments[Math.floor(Math.random() * comments.length)];
}

export function selectComment(diffFromLastMonth: number | null): string {
	let comment: string;

	if (diffFromLastMonth === null) {
		comment = getRandomComment(NO_DATA_COMMENTS);
	} else if (diffFromLastMonth > 0.3) {
		comment = getRandomComment(WEIGHT_GAIN_COMMENTS);
		comment = comment.replace('{diff}', Math.abs(diffFromLastMonth).toFixed(1));
	} else if (diffFromLastMonth < -0.3) {
		comment = getRandomComment(WEIGHT_LOSS_COMMENTS);
		comment = comment.replace('{diff}', Math.abs(diffFromLastMonth).toFixed(1));
	} else {
		comment = getRandomComment(WEIGHT_STABLE_COMMENTS);
	}

	return comment;
}
