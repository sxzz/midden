// What language detection reads of a text before any model sees it: the
// text without links, mentions, hashtags and emoji, and the scripts it is
// written in. Japanese and Korean are told by their scripts alone (kana,
// Hangul), which no statistical model beats; text written only in Han
// characters is Chinese unless it uses forms only Japanese writes, and
// Chinese is told simplified or traditional by the characters only one of
// them uses.

const URL =
  /\b(?:https?:\/\/|www\.)[^\s<>"'`()（）「」『』【】〈〉《》、。，！？…]+/giu
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu
const MENTION = /(?<![\w@])[@＠]\w+/gu
// A hashtag runs to the end of its word: letters (the katakana long vowel
// mark among them), marks, digits, `_` and the katakana middle dot, as X
// counts them.
const HASHTAG = /(?<![\p{L}\p{M}\p{Nd}_&/])[#＃][\p{L}\p{M}\p{Nd}_・]+/gu
// Emoji with their modifiers, joiners, variation selectors and keycaps;
// digits and `#` are emoji components too, so those are matched only as
// part of a keycap. The joiner and selectors stand outside the class,
// where they would read as one joined character.
const EMOJI =
  // eslint-disable-next-line regexp/prefer-character-class
  /(?:[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}]|\u{200D}|\u{FE0E}|\u{FE0F}|\u{20E3})+/gu
const SPACE = /\s+/gu

/** The text as the detector reads it: no links, handles, tags or emoji. */
export function cleanText(text: string): string {
  return text
    .normalize('NFKC')
    .replaceAll(URL, ' ')
    .replaceAll(EMAIL, ' ')
    .replaceAll(MENTION, ' ')
    .replaceAll(HASHTAG, ' ')
    .replaceAll(EMOJI, ' ')
    .replaceAll(SPACE, ' ')
    .trim()
}

// The model splits words at spaces only, so `much!!` would be a word it has
// never seen; nor does case tell it much.
const NOT_WORD = /[^\p{L}\p{M}\p{N}'’]+/gu
const CJK_CHAR = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]+/gu

/**
 * The text as the model reads it: words in lower case between single
 * spaces. Without `cjk`, CJK and Hangul characters are left out, for text
 * mostly in another script: a 日 in `EN/日` would otherwise outweigh the
 * English around it.
 */
export function modelText(text: string, cjk = true): string {
  const words = text.toLowerCase().replaceAll(NOT_WORD, ' ')
  return (cjk ? words : words.replaceAll(CJK_CHAR, ' '))
    .replaceAll(SPACE, ' ')
    .trim()
}

export interface Scripts {
  kana: number
  han: number
  hangul: number
  /** Letters of any other script (Latin, Cyrillic, ...). */
  other: number
}

const KANA = /[\p{sc=Hiragana}\p{sc=Katakana}]/u
const HAN = /\p{sc=Han}/u
const HANGUL = /\p{sc=Hangul}/u
const LETTER = /\p{L}/u

/** How many letters of each script a (cleaned) text has. */
export function countScripts(text: string): Scripts {
  const counts: Scripts = { kana: 0, han: 0, hangul: 0, other: 0 }
  for (const char of text) {
    if (KANA.test(char)) counts.kana++
    else if (HAN.test(char)) counts.han++
    else if (HANGUL.test(char)) counts.hangul++
    else if (LETTER.test(char)) counts.other++
  }
  return counts
}

/**
 * One CJK character carries about as much as a few Latin letters (a Hangul
 * syllable is two or three of its letters), so scripts are compared by
 * these weights.
 */
export const CJK_WEIGHT = 3
export const HANGUL_WEIGHT = 2

/** The letters of a text, weighted as above. */
export const weightOf = (s: Scripts) =>
  (s.kana + s.han) * CJK_WEIGHT + s.hangul * HANGUL_WEIGHT + s.other

/**
 * What the scripts alone say: `ja` for kana among the Han characters, `ko`
 * for Hangul, `han` for Han characters with (almost) no kana, all when that
 * script outweighs the rest; undefined when another script does, for the
 * model to decide.
 */
export function scriptRule(s: Scripts): 'ja' | 'ko' | 'han' | undefined {
  const cjk = (s.kana + s.han) * CJK_WEIGHT
  const hangul = s.hangul * HANGUL_WEIGHT
  if (hangul > 0 && hangul >= cjk && hangul >= s.other) return 'ko'
  if (cjk > 0 && cjk >= s.other) {
    // Japanese writes kana between its kanji; Chinese may borrow a の, and
    // a kaomoji brings a ノ.
    return s.kana > 0 && s.kana >= (s.kana + s.han) * 0.2 ? 'ja' : 'han'
  }
  return undefined
}

// Character forms only Japanese uses (shinjitai and kokuji), neither
// simplified nor traditional Chinese.
const JAPANESE_ONLY = new Set(
  '気図発楽円対戦広駅売読険様歳関込働畑峠枠辻凪実鉄児県変単価経続歩薬沢浜検験権斉剤済渋獣縦焼乗浄畳縄壌嬢譲醸寝粋酔枢瀬摂専銭潜繊巣総騒増臓蔵帯滝択弾遅庁聴転伝闘徳届悩脳廃払仏辺舗満黙訳揺謡頼覧竜猟緑涙塁霊齢暦歴労録拝抜髪稲黒亜悪圧囲栄営縁桜穏絵拡殻覚巻陥寛歓観偽戯犠拠挙郷暁駆茎恵掲渓継軽鶏芸剣圏倹厳効恒鉱穀砕斎雑桟蚕賛残糸歯釈収従粛処叙奨祥証剰嘱慎髄禅壮捜挿僧憎堕団稚鋳徴懲勅塚逓盗突弐覇繁晩卑碑賓瓶侮併塀穂豊褒墨翻毎麺弥欄隆虜両類戻錬郎廊'.split(
    '',
  ),
)

// Common characters that only simplified, or only traditional, Chinese
// writes (about 800 each).
const SIMPLIFIED =
  '们这个时说国会对发经过动开关问还进没学样长现见东车听点头书门边让两给话请认识记觉买卖钱员电写爱师乐专业气实应该从为么吗难题网页图视频钟脑机级场间变运节约论线结红绿蓝颜饭馆鸡鱼鸟马龙龟凤风飞闻闪阅读诗词语译谁谈谢课调证议许设访试诉讲谱贝财货贵费资赛赶转轮软轻较辆输远连迟适选递逻郁铁银锅错镜闭闲闹队阳阴阵际陆陈险随隐雾须顺顾预领频额飘饮饱饼驾验骑骗鲜鸭鹅麦黄齐齿龄猫体湾后里帐号灯热张岁带华单厅厂广亲众优伤传儿兴写农冻减几刘则刚创别办务动劳势区医华协单卖卫历压厉县参双变号叹吓员呜咱响哑唤啰团园围图圆圣场坏块坚坛垄垒垫执夺奋奖妈妇妆娱婴宁宝实宠宫宽对寻导寿将尔尘尝层岁岛岭峡币帅师帐带帮库庆应庙废开异弃张弹强归当录彻径忆态怀怜总恶恼悬惊惧惨惯戏战户扑执扩扫扬扰抚抢护报拟拥择挂挡挣挤挥损换据掳摄摆摇摊撑敌数斋断时旷显晒晓晕暂术机杀杂权条来杨极构枪柜标栋树样桥桩梦检椭楼欢欧歼毁毕气汇汉汤沟没沪泪泼泽洁洒浅浇浊测济浏浑浓涌涛涝涨润涩渊渐渔温湿满滚滞滤滥滨灭灵灾炉点炼烁烂烛烟烦烧烫热焕爱爷牵犹狮独狭狱猎献环现玛珑琐电画畅疗疮疯痒痴瘫盏监盘矿码砖础确碍礼祷祸离秃种积称稳穷窃窍窜竞笔笼筑筛简签粮紧纠红约级纪纯纱纲纳纵纷纸纹纺纽线练组细织终绍经结绕绘给络绝统继续绳维绵综绿缓编缘缩缴网罗罚罢职联聪肃肠肤肾肿胀胁脏脑脚脱舰舱艺节芦苏苹茧荐荡荣药莱获营萧蔼虑虫虽蚀蚂蛮补衬袜装见观规视览觉触誉计订认讨让训议讯记讲讶许论设访证评识诈诉词译试诗诚话诞询该详语误说请诸读课谁调谈谊谋谓谢谣谦谨谱贝负贡财责贤败账货质贩贫购贯贴贵贷贸费贺赏赔赖赚赞赠赵趋跃践踪轨轮软轰轻载较辅辈辉输辞辩边达迁过迈运还进远违连迟适选逊递逻遗邓邮邻郁郑酱释里鉴钉针钓钟钢钥钱钻铁铃铜铝银铺链销锁锅锋错锡锦键锻镇镜长门闪闭问闯闲间闷闹闻阀阁阅队阳阴阵阶际陆陈陕险随隐隶难雾静须顶项顺顽顾顿颁预领颇频颗题额颜风飘飞饥饭饮饰饱饲饼馆首驱驳驶驻驾骂骄骆验骑骗骚骤鱼鲁鲜鸡鸣鸦鸭鸽鹅鹰鹿麦黄齐齿龄龙龟'
const TRADITIONAL =
  '們這個時說國會對發經過動開關問還進沒學樣長現見東車聽點頭書門邊讓兩給話請認識記覺買賣錢員電寫愛師樂專業氣實應該從為麼嗎難題網頁圖視頻鐘腦機級場間變運節約論線結紅綠藍顏飯館雞魚鳥馬龍龜鳳風飛聞閃閱讀詩詞語譯誰談謝課調證議許設訪試訴講譜貝財貨貴費資賽趕轉輪軟輕較輛輸遠連遲適選遞邏鬱鐵銀鍋錯鏡閉閒鬧隊陽陰陣際陸陳險隨隱霧須順顧預領頻額飄飲飽餅駕驗騎騙鮮鴨鵝麥黃齊齒齡貓體灣後裡帳號燈熱張歲帶華單廳廠廣親眾優傷傳價兒興寫農凍減幾劉則剛創別辦務動勞勢區醫華協單賣衛歷壓厲縣參雙變葉號嘆嚇員嗚咱響啞喚囉團園圍圖圓聖場壞塊堅壇壟壘墊執奪奮獎媽婦妝娛嬰寧寶實寵宮寬對尋導壽將爾塵嘗層歲島嶺峽幣帥師帳帶幫庫慶應廟廢開異棄張彈強歸當錄徹徑憶態懷憐總惡惱懸驚懼慘慣戲戰戶撲執擴掃揚擾撫搶護報擬擁擇掛擋掙擠揮損換據擄攝擺搖攤撐敵數齋斷時曠顯曬曉暈暫術機殺雜權條來楊傑鬆極構槍櫃標棟樹樣橋樁夢檢橢樓歡歐殲毀畢氣匯漢湯溝沒滬淚潑澤潔灑淺澆濁測濟瀏渾濃湧濤澇漲潤澀淵漸漁溫濕滿滾滯濾濫濱滅靈災爐點煉爍爛燭煙煩燒燙熱煥愛爺牽猶獅獨狹獄獵獻環現瑪瓏瑣電畫暢療瘡瘋癢癡癱盞監盤礦碼磚礎確礙禮禱禍離禿種積稱穩窮竊竅竄競筆籠築篩簡簽糧緊糾紅約級紀純紗綱納縱紛紙紋紡紐線練組細織終紹經結繞繪給絡絕統繼續繩維綿綜綠緩編緣縮繳網羅罰罷職聯聰肅腸膚腎腫脹脅髒腦腳脫艦艙藝節蘆蘇蘋範繭薦蕩榮藥萊獲營蕭藹慮蟲雖蝕螞蠻補襯襪裝見觀規視覽覺觸譽計訂認討讓訓議訊記講訝許論設訪證評識詐訴詞譯試詩誠話誕詢該詳語誤說請諸讀課誰調談誼謀謂謝謠謙謹譜貝負貢財責賢敗賬貨質販貧購貫貼貴貸貿費賀賞賠賴賺讚贈趙趨躍踐蹤軌輪軟轟輕載較輔輩輝輸辭辯邊達遷過邁運還進遠違連遲適選遜遞邏遺鄧郵鄰鬱鄭醬釋裏鑑釘針釣鐘鋼鑰錢鑽鐵鈴銅鋁銀鋪鏈銷鎖鍋鋒錯錫錦鍵鍛鎮鏡長門閃閉問闖閒間悶鬧聞閥閣閱隊陽陰陣階際陸陳陝險隨隱隸難霧靜須頂項順頑顧頓頒預領頗頻顆題額顏風飄飛飢飯飲飾飽飼餅館首驅駁駛駐駕罵驕駱驗騎騙騷驟魚魯鮮雞鳴鴉鴨鴿鵝鷹鹿麥黃齊齒齡龍龜'

// Characters the two lists share (首, 鹿, 咱: written the same in both)
// say nothing either way.
const SHARED = new Set([...SIMPLIFIED].filter((c) => TRADITIONAL.includes(c)))
const HANS = new Set([...SIMPLIFIED].filter((c) => !SHARED.has(c)))
const HANT = new Set([...TRADITIONAL].filter((c) => !SHARED.has(c)))

/**
 * What the Han characters of a text say: `ja` when it uses a form only
 * Japanese writes, otherwise `zh-Hans` or `zh-Hant` by which characters it
 * has more of, or `zh` when it has none of either.
 */
export function hanLang(text: string): 'ja' | 'zh-Hans' | 'zh-Hant' | 'zh' {
  let hans = 0
  let hant = 0
  let japanese = 0
  for (const char of text) {
    if (HANS.has(char)) hans++
    else if (HANT.has(char)) hant++
    if (JAPANESE_ONLY.has(char)) japanese++
  }
  // A Japanese form among more simplified than traditional characters is
  // more likely one both share by accident (the lists overlap: 来, 楽).
  if (japanese > 0 && japanese >= hans) return 'ja'
  if (hans > hant) return 'zh-Hans'
  if (hant > hans) return 'zh-Hant'
  return 'zh'
}

/** A Chinese text told simplified or traditional; other languages as given. */
export function withScript(lang: string, text: string): string {
  if (lang !== 'zh') return lang
  const han = hanLang(text)
  return han === 'ja' ? 'zh' : han
}
