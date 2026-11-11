import type { CSSProperties } from "react";

/** 开机动画里的文字全部由 CSS 的 attr(data-text) 画出，不进入 DOM 文本，页面文字检索和无障碍朗读都不会读到。 */
const COPY = {
  zh: { title: "AI 小说生成器", chapter: "第一章", opening: "故事从这里开始。", outline: "大纲", draft: "初稿", inscription: "落笔成章", tagline: "长篇小说写作", engine: "故事引擎", idea: "灵感", characters: "人物", conflict: "目标 · 冲突", world: "世界", clues: "规则 · 设定" },
  en: { title: "AI Novel Generator", chapter: "Chapter One", opening: "The story begins here.", outline: "Outline", draft: "DRAFT", inscription: "", tagline: "Long-form fiction", engine: "Story engine", idea: "Ideas", characters: "Characters", conflict: "Goals · Conflict", world: "World", clues: "Rules · Lore" },
} as const;

/** 纸飞机的航线（休闲风格），轨迹虚线和飞机的 offset-path 共用，坐标系是 800×400 的 .ca-sky。 */
const FLIGHT = "M -60 340 C 80 310, 150 150, 270 170 S 400 320, 500 240 S 580 110, 650 118";
/** 休闲风格的手绘涂鸦（同一坐标系）：左上角的小太阳（一圈 + 八道短光芒）、书名旁的两颗闪光、右下角的小星星。 */
const SUN_RING = "M 120 64 C 136 63, 147 76, 146 91 C 145 106, 133 117, 118 116 C 103 115, 93 103, 94 89 C 95 76, 106 66, 121 65";
const SUN_RAYS = [[150, 90, 160, 90], [141, 111, 148, 118], [120, 120, 120, 130], [99, 111, 92, 118], [90, 90, 80, 90], [99, 69, 92, 62], [120, 60, 120, 50], [141, 69, 148, 62]];
const SPARKS = ["M 196 150 l 0 -14 M 189 143 l 14 0", "M 610 268 l 0 -10 M 605 263 l 10 0"];
const STAR = "M 700 300 L 707 316 L 724 317 L 711 328 L 716 345 L 700 335 L 685 345 L 689 328 L 677 317 L 693 316 Z";
/** 水墨远山：两层山形，坐标系 1200×300，底边贴着画面下沿。 */
const INK_FAR = "M0 300 L0 210 C 60 200, 90 160, 140 150 C 180 142, 200 176, 240 170 C 300 160, 330 110, 380 104 C 420 100, 440 140, 470 150 C 500 160, 520 190, 560 196 L 640 200 C 700 196, 720 150, 770 132 C 810 118, 840 150, 870 160 C 920 176, 960 130, 1010 120 C 1060 112, 1100 160, 1140 170 L 1200 176 L 1200 300 Z";
const INK_NEAR = "M0 300 L0 250 C 40 240, 70 214, 120 210 C 170 206, 200 236, 250 238 C 300 240, 330 220, 360 222 L 840 236 C 880 230, 910 206, 960 200 C 1010 196, 1040 222, 1090 226 C 1130 230, 1170 214, 1200 210 L 1200 300 Z";
/** 森林远处的树（左右两侧，避开中间那颗芽）：位置（% 横坐标）、高度（rem）、形状（松树 / 圆冠）。 */
const TREES = [
  { x: 24, h: 3.6, k: "pine" }, { x: 30, h: 2.4, k: "round" }, { x: 35, h: 3, k: "pine" },
  { x: 65, h: 2.8, k: "round" }, { x: 70, h: 3.8, k: "pine" }, { x: 76, h: 2.2, k: "round" },
] as const;
/** 前景的芦苇 / 草叶（雾蓝、治愈、森林共用的一丛），坐标系 120×100，底边贴地。 */
const REEDS = ["M20 100 C 22 70, 18 40, 26 6", "M34 100 C 34 74, 40 50, 52 22", "M48 100 C 46 80, 50 60, 46 38", "M64 100 C 66 78, 74 58, 92 40", "M78 100 C 78 84, 84 70, 100 62"];
/** 水墨右上角伸进画面的一枝松：枝干和几簇松针，坐标系 300×160。 */
const PINE_BRANCH = "M300 18 C 250 22, 214 40, 180 46 C 150 52, 128 46, 104 58 C 90 65, 80 76, 70 90";
const PINE_TUFTS = [[214, 38], [162, 50], [118, 54], [84, 80]] as const;
/** 雾蓝夜里和阳光黎明的星点（% 坐标）。 */
const STARS = [[12, 14], [22, 26], [34, 10], [47, 20], [58, 8], [66, 24], [78, 12], [88, 22], [93, 9]] as const;

const vars = (values: Record<string, string | number>) => values as CSSProperties;

/** 逐字出现的标题：每个字一个 span，--i 是序号、--n 是总字数，各风格按它们错开出现时刻。 */
function Chars({ text, className }: { text: string; className: string }) {
  const chars = Array.from(text);
  return (
    <span className={className} style={vars({ "--n": chars.length })}>
      {chars.map((ch, i) => <span key={i} className="bs-ch" style={vars({ "--i": i })} data-text={ch} />)}
    </span>
  );
}

/**
 * 十一种风格的开机画面都在这里，同时渲染；CSS 按 html 的 data-look 只显示当前风格那一幕（其余 display:none，不播放）。
 * 服务端不知道用户选了哪种风格，这样首帧就能直接是对的画面。每幕两三段，动作编排见 styles/looks/boot-*.css。
 * Args: lang 界面语言。
 * Returns: 所有风格的场景节点。
 */
export default function BootScenes({ lang }: { lang: "zh" | "en" }) {
  const t = COPY[lang];
  const len = (text: string) => Array.from(text).length;
  return (
    <>
      {/* 科技：一个写作编辑器。先搭好标签栏、状态栏和右侧大纲栏；再逐行敲出“# 书名”“## 第一章”，大纲栏随之列出两项；
          最后在正文行敲下第一句，光标停在句尾闪。--n1/--n2/--n3 是三行的字数，各行的起止时刻按它们推算。 */}
      <div className="bs-scene" data-scene="tech" style={vars({ "--n1": len(t.title), "--n2": len(t.chapter), "--n3": len(t.opening) })}>
        <div className="te-cosmos">
          <i className="te-grid" />
          {Array.from({ length: 20 }, (_, i) => <i key={i} className="te-star" style={vars({ "--x": `${(i * 37 + 7) % 96}%`, "--y": `${(i * 53 + 9) % 88}%`, "--i": i })} />)}
        </div>
        <div className="te-core">
          <i className="te-core-ring te-core-ring-a" /><i className="te-core-ring te-core-ring-b" />
          <span className="te-core-book"><i /><i /></span>
          <span className="te-core-title" data-text={t.title} />
          <span className="te-core-tag" data-text={t.tagline} />
        </div>
        <div className="te-bar"><span className="te-tab" data-text="novel.md"><i className="te-tab-dot" /></span><span className="te-engine"><i /><span data-text={t.engine} /></span></div>
        <div className="te-area">
          <div className="te-editor">
            <i className="te-hl" />
            <div className="te-row te-r1"><span className="te-no" data-text="1" /><span className="te-mark" data-text="# " /><Chars text={t.title} className="te-text te-h1" /><i className="te-caret" /></div>
            <div className="te-row te-r2"><span className="te-no" data-text="2" /><i className="te-caret" /></div>
            <div className="te-row te-r3"><span className="te-no" data-text="3" /><span className="te-mark" data-text="## " /><Chars text={t.chapter} className="te-text te-h2" /><i className="te-caret" /></div>
            <div className="te-row te-r4"><span className="te-no" data-text="4" /><i className="te-caret" /></div>
            <div className="te-row te-r5"><span className="te-no" data-text="5" /><Chars text={t.opening} className="te-text te-p" /><i className="te-caret" /></div>
            <div className="te-ghost">{[0, 1, 2, 3, 4].map((i) => <i key={i} style={vars({ "--i": i })} />)}</div>
          </div>
        </div>
        <div className="te-side">
          <span className="te-side-head" data-text={t.outline} />
          <span className="te-side-item te-o1" data-text={t.title} />
          <span className="te-side-item te-o2" data-text={t.chapter} />
          <div className="te-side-flow">
            <span data-text={t.idea} /><i /><span data-text={t.outline} /><i /><span data-text={t.draft} />
            <b><i /><i /><i /><i /><i /></b>
          </div>
        </div>
        <div className="te-status"><span data-text="Markdown · UTF-8" /></div>
        <div className="te-constellation">{[0, 1, 2, 3].map((i) => <i key={i} style={vars({ "--i": i })} />)}<b /><b /><b /></div>
        <div className="te-complete"><i /><span data-text={t.draft} /></div>
        {/* 待机：进度一时停住时，正文下面新起一行，光标边闪边“想”，三个点轮流浮起（样式 boot-layers.css） */}
        <div className="bs-idle te-idle"><i className="te-idle-caret" /><b /><b /><b /></div>
      </div>

      {/* 雾蓝：一片白雾向两边散开，露出三层远山和一面湖；书名从雾里慢慢清楚，一只小船从湖面划过。夜里是一弯月亮和几点星。 */}
      <div className="bs-scene" data-scene="mist">
        {STARS.map(([x, y], i) => <i key={i} className="mi-star" style={vars({ "--x": `${x}%`, "--y": `${y}%`, "--i": i })} />)}
        <i className="mi-orb" />
        <i className="mi-hill mi-h3" /><i className="mi-hill mi-h2" /><i className="mi-hill mi-h1" />
        <div className="mi-lake"><i className="mi-mirror" />{[0, 1, 2].map((i) => <i key={i} className="mi-glint" style={vars({ "--i": i })} />)}</div>
        <div className="mi-boat"><i className="mi-sail" /><i className="mi-hull" /><i className="mi-wake" /></div>
        <i className="mi-fog mi-f1" /><i className="mi-fog mi-f2" />
        <div className="mi-title" data-text={t.title} />
        <i className="mi-line" />
        <i className="mi-veil mi-veil-l" /><i className="mi-veil mi-veil-r" />
        <div className="mi-ripples">{[0, 1, 2].map((i) => <i key={i} style={vars({ "--i": i })} />)}</div>
        <div className="mi-birds"><i /><i /></div>
        {/* 前景：左右两丛芦苇，湖边的近景，比远山深一层 */}
        {[0, 1].map((side) => <svg key={side} className={`mi-reeds mi-reeds-${side ? "r" : "l"}`} viewBox="0 0 120 100" preserveAspectRatio="xMidYMax meet" aria-hidden="true" focusable="false">
          {REEDS.map((d, i) => <path key={i} d={d} style={vars({ "--i": i })} />)}
        </svg>)}
        {/* 待机：一缕雾从书名前慢慢飘过，两只鸟远远掠过湖面 */}
        <div className="bs-idle mi-idle"><i className="mi-idle-fog" /><i className="mi-idle-bird" /><i className="mi-idle-bird" /></div>
      </div>

      {/* 森林：地平线展开，一粒种子落进土里；芽破土长高，三片叶子先后张开；两边远处的树一棵棵冒出来，脚下长出草，书名从地面下浮上来。
          白天几片叶子飘落，夜里换成萤火。 */}
      <div className="bs-scene" data-scene="forest">
        {[0, 1, 2, 3, 4, 5].map((i) => <i key={i} className="fo-float" style={vars({ "--i": i })} />)}
        {TREES.map((tree, i) => <i key={i} className={`fo-tree fo-${tree.k}${Math.abs(tree.x - 50) < 20 ? " fo-inner" : ""}`} style={vars({ "--x": `${tree.x}%`, "--h": `${tree.h}rem`, "--d": `${(1.85 + Math.abs(tree.x - 50) / 100 + (i % 3) * 0.05).toFixed(2)}s` })} />)}
        <i className="fo-seed" />
        <div className="fo-sprout"><i className="fo-stem" /><i className="fo-lf fo-lf-l" /><i className="fo-lf fo-lf-r" /><i className="fo-bud" /></div>
        <i className="fo-ground" />
        {[-1, 1].map((side) => <i key={side} className="fo-grass" style={vars({ "--s": side })} />)}
        <div className="fo-title" data-text={t.title} />
        <div className="fo-vine fo-vine-l">{[0, 1, 2].map((i) => <i key={i} style={vars({ "--i": i })} />)}</div>
        <div className="fo-vine fo-vine-r">{[0, 1, 2].map((i) => <i key={i} style={vars({ "--i": i })} />)}</div>
        <div className="fo-pollen">{[0, 1, 2, 3, 4].map((i) => <i key={i} style={vars({ "--i": i })} />)}</div>
        {/* 远景一道起伏的山脊线、前景两角的蕨叶：和地平线上的芽、小树组成三层 */}
        <i className="fo-ridge" />
        {[0, 1].map((side) => <svg key={side} className={`fo-fern fo-fern-${side ? "r" : "l"}`} viewBox="0 0 120 100" preserveAspectRatio="xMidYMax meet" aria-hidden="true" focusable="false">
          {REEDS.map((d, i) => <path key={i} d={d} style={vars({ "--i": i })} />)}
        </svg>)}
        {/* 待机：白天一只小蝴蝶绕着芽飞，夜里换成一点萤火 */}
        <div className="bs-idle fo-idle"><i className="fo-fly"><b /><b /></i></div>
      </div>

      {/* 暖棕：书房的吊灯垂下来、拉亮，屋里一下暖了；一本精装书落在灯下，封面烫金边框显出来，书签丝带垂下；
          封面沿书脊翻开，扉页上一个字一个字浮出书名，下面是“第一章”和几道横线。 */}
      <div className="bs-scene" data-scene="warm">
        <i className="wa-dim" />
        <div className="wa-lamp"><i className="wa-cone" /><i className="wa-cord" /><i className="wa-shade" /><i className="wa-bulb" /><i className="bs-idle wa-chain" /></div>
        <i className="wa-pool" />
        <div className="wa-book">
          <div className="wa-shift">
            <div className="wa-page">
              <Chars text={t.title} className="wa-title" />
              <div className="wa-chapter" data-text={t.chapter} />
              {[0, 1, 2].map((i) => <i key={i} className="wa-rule" style={vars({ "--i": i })} />)}
            </div>
            <div className="wa-cover">
              <div className="wa-front"><i className="wa-frame" /><i className="wa-orn" /><i className="wa-orn wa-orn-2" /></div>
              <i className="wa-inside"><b className="wa-endpaper" /></i>
            </div>
            <i className="wa-ribbon" />
          </div>
        </div>
        <div className="wa-tea"><i className="wa-cup" /><i className="wa-steam wa-steam-a" /><i className="wa-steam wa-steam-b" /></div>
        <div className="wa-dust">{[0, 1, 2, 3, 4, 5].map((i) => <i key={i} style={vars({ "--i": i })} />)}</div>
        {/* 前景：书桌的木纹桌沿，书旁一支钢笔 */}
        <i className="wa-desk" />
        <i className="wa-pen" />
      </div>

      {/* 可爱：一张便签“啪”地贴上来，两条纸胶带压住两角，书名一个字一个字蹦上去；小猫从便签后面探出头、搭上爪子，眨眼、抖耳朵；
          一团毛线滚过来，小猫的眼睛跟着它转，尾巴从便签边上甩出来，便签角盖上一个小爪印。 */}
      <div className="bs-scene" data-scene="cute">
        {[0, 1, 2, 3, 4, 5].map((i) => <i key={i} className="cu-dot" style={vars({ "--i": i })} />)}
        <i className="cu-moon" />
        <div className="cu-sky">
          {[0, 1, 2, 3].map((i) => <i key={i} className="cu-cloud" style={vars({ "--i": i })} />)}
          {Array.from({ length: 8 }, (_, i) => <i key={i} className="cu-sparkle" style={vars({ "--i": i })} />)}
        </div>
        <i className="cu-rainbow" />
        <div className="cu-sticker cu-book"><i className="cu-book-page cu-book-left" /><i className="cu-book-page cu-book-right" /><i className="cu-book-heart" /></div>
        <div className="cu-sticker cu-pencil"><i /><b /></div>
        <i className="cu-plane" />
        <div className="cu-garden"><i className="cu-hill cu-hill-l" /><i className="cu-hill cu-hill-r" />
          {Array.from({ length: 7 }, (_, i) => <i key={i} className="cu-flower" style={vars({ "--i": i })} />)}
        </div>
        <div className="cu-wrap">
          <i className="cu-tail" />
          <div className="cu-cat">
            <i className="cu-ear cu-ear-l" /><i className="cu-ear cu-ear-r" />
            <div className="cu-head"><div className="cu-eyes"><i className="cu-eye cu-eye-l" /><i className="cu-eye cu-eye-r" /></div><i className="cu-blush cu-blush-l" /><i className="cu-blush cu-blush-r" /><i className="cu-mouth" /></div>
          </div>
          <div className="cu-card"><Chars text={t.title} className="cu-title" /><i className="cu-stamp" /></div>
          <i className="cu-tape cu-tape-l" /><i className="cu-tape cu-tape-r" />
          <i className="cu-paw cu-paw-l" /><i className="cu-paw cu-paw-r" />
          <i className="cu-heart cu-heart-1" /><i className="cu-heart cu-heart-2" />
          <svg className="cu-thread" viewBox="0 0 120 40" aria-hidden="true" focusable="false"><path pathLength={1} d="M 118 30 C 96 38, 80 20, 60 28 S 22 36, 4 26" /></svg>
          <div className="cu-yarn"><i className="cu-yarn-in" /></div>
          <svg className="cu-scribble" viewBox="0 0 120 36" aria-hidden="true" focusable="false"><path pathLength={1} d="M4 23 C18 5, 29 34, 43 17 S70 6, 78 20 S99 31, 116 10" /></svg>
          <div className="cu-confetti">{[0, 1, 2, 3, 4, 5].map((i) => <i key={i} style={vars({ "--i": i })} />)}</div>
          {/* 待机：等得久了，小猫打起盹，头顶飘出几个 z */}
          <div className="bs-idle cu-idle">{[0, 1, 2].map((i) => <span key={i} data-text="z" style={vars({ "--i": i })} />)}</div>
        </div>
      </div>

      {/* 休闲：纸飞机从左下角飞进来，身后留一串点状航迹，兜一圈停在书名右上方轻轻起伏；书名歪着落下，下面随手画一道波浪线；
          最后左上角随手描一个小太阳，书名旁点两颗闪光，右下角画一颗小星星。 */}
      <div className="bs-scene" data-scene="casual">
        <i className="ca-cloud ca-c1" /><i className="ca-cloud ca-c2" /><i className="ca-cloud ca-c3" />
        <div className="ca-sky">
          <svg className="ca-trail" viewBox="0 0 800 400" aria-hidden="true" focusable="false">
            <defs><mask id="ca-trail-mask" maskUnits="userSpaceOnUse" x="-100" y="0" width="1000" height="400"><path d={FLIGHT} pathLength={1} className="ca-reveal" /></mask></defs>
            <path d={FLIGHT} className="ca-dash" mask="url(#ca-trail-mask)" />
            <g className="ca-doodle">
              <path className="ca-sun" pathLength={1} d={SUN_RING} />
              {SUN_RAYS.map(([x1, y1, x2, y2], i) => <path key={i} className="ca-ray" pathLength={1} d={`M ${x1} ${y1} L ${x2} ${y2}`} style={vars({ "--i": i })} />)}
              {SPARKS.map((d, i) => <path key={i} className="ca-spark" pathLength={1} d={d} style={vars({ "--i": i })} />)}
              <path className="ca-star" pathLength={1} d={STAR} />
            </g>
          </svg>
          <div className="ca-plane" style={{ offsetPath: `path("${FLIGHT}")` }}><div className="ca-plane-in">
            <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path className="ca-wing" d="M46 24 4 8 14 24 4 40Z" /><path className="ca-flap" d="M46 24 14 24 20 34Z" /></svg>
          </div></div>
        </div>
        <div className="ca-title" data-text={t.title} />
        <svg className="ca-underline" viewBox="0 0 240 20" aria-hidden="true" focusable="false"><path pathLength={1} d="M4 12 Q 34 2 64 12 T 124 12 T 184 12 T 236 9" /></svg>
        <div className="ca-scraps">{[0, 1, 2].map((i) => <i key={i} style={vars({ "--i": i })}><b /><b /><b /></i>)}</div>
        <i className="ca-pencil"><b /></i>
        {/* 待机：铅笔在书名右下角随手绕圈，画完擦掉再画 */}
        <svg className="bs-idle ca-idle" viewBox="0 0 80 40" aria-hidden="true" focusable="false"><path pathLength={1} d="M6 30 C 14 6, 34 6, 30 22 C 26 36, 12 30, 22 18 C 32 6, 52 8, 50 24 C 48 36, 36 30, 44 20 C 52 10, 70 12, 74 26" /></svg>
      </div>

      {/* 阳光：黎明前的天上还有几颗星，地平线先亮起一道暖色；太阳从两座小山之间升起，光芒慢慢转开，星星隐去，天色褪成白天的暖白；
          两朵扁云飘进来，小鸟飞过，书名落在地平线下，脚下冒出一排小花。暗色是傍晚：太阳更红、往下沉，星星一颗颗亮起来。 */}
      <div className="bs-scene" data-scene="sunny">
        <i className="su-dawn" />
        {STARS.map(([x, y], i) => <i key={i} className="su-star" style={vars({ "--x": `${x}%`, "--y": `${y * 0.8}%`, "--i": i })} />)}
        <i className="su-glow" />
        <div className="su-sky"><div className="su-sun"><i className="su-rays" /><i className="su-disc" /></div></div>
        <i className="su-cloud su-cl1" /><i className="su-cloud su-cl2" />
        <i className="su-hill su-hl" /><i className="su-hill su-hr" />
        <i className="su-bird su-b1" /><i className="su-bird su-b2" />
        <i className="su-ground" />
        {[0, 1, 2, 3, 4, 5, 6].map((i) => <i key={i} className="su-stem" style={vars({ "--i": i })} />)}
        <div className="su-title" data-text={t.title} />
        <div className="su-seeds">{[0, 1, 2, 3, 4, 5].map((i) => <i key={i} style={vars({ "--i": i })} />)}</div>
        <div className="su-field">{[0, 1, 2, 3, 4].map((i) => <i key={i} style={vars({ "--i": i })} />)}</div>
        {/* 前景：近处一道更深的草坡，坡上几簇草 */}
        <div className="su-near">{[0, 1, 2, 3, 4, 5].map((i) => <i key={i} style={vars({ "--i": i })} />)}</div>
        {/* 待机：草坡上插着的小风车，风一来就转 */}
        <div className="bs-idle su-idle"><i className="su-pin-stick" /><i className="su-pin-wheel"><b /><b /><b /><b /></i></div>
      </div>

      {/* 治愈：一片叶子从上面垂进画面，叶尖慢慢攒出一滴水；水滴落进湖面，涟漪一圈圈散开，旁边的睡莲叶跟着轻轻晃；
          书名一个字一个字浮上来，水面上是它淡淡的倒影。 */}
      <div className="bs-scene" data-scene="heal">
        <i className="he-blob he-b1" /><i className="he-blob he-b2" /><i className="he-blob he-b3" />
        <div className="he-leaf"><i className="he-leaf-in" /><i className="he-bead" /></div>
        <i className="he-water" />
        <div className="he-pond">{[0, 1, 2].map((i) => <i key={i} className="he-ring" style={vars({ "--i": i })} />)}</div>
        <div className="he-pad"><i className="he-pad-in" /><i className="he-bloom" /></div>
        <i className="he-drop" />
        <Chars text={t.title} className="he-title" />
        <Chars text={t.title} className="he-title he-echo" />
        <div className="he-petals">{[0, 1, 2, 3].map((i) => <i key={i} style={vars({ "--i": i })} />)}</div>
        <i className="he-shine" />
        {/* 前景：左边一丛水草，水边几块卵石 */}
        <svg className="he-reeds" viewBox="0 0 120 100" preserveAspectRatio="xMidYMax meet" aria-hidden="true" focusable="false">
          {REEDS.map((d, i) => <path key={i} d={d} style={vars({ "--i": i })} />)}
        </svg>
        <div className="he-stones">{[0, 1, 2, 3].map((i) => <i key={i} style={vars({ "--i": i })} />)}</div>
        {/* 待机：叶尖又攒出一滴水，落下去荡开一圈 */}
        <div className="bs-idle he-idle"><i className="he-idle-drop" /><i className="he-idle-ring" /></div>
      </div>

      {/* 水墨：宣纸上一滴墨晕开，成了一轮淡墨的月；远山一层一层从左往右染出来；竖排书名逐字像墨渗进纸里那样显出，
          最后一方朱印压下去，旁边一行小字题款，两只飞鸟远远掠过。暗色把墨和纸反过来，朱印不变。 */}
      <div className="bs-scene" data-scene="ink">
        <svg className="in-defs" aria-hidden="true" focusable="false"><filter id="in-rough"><feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="3" seed="7" /><feDisplacementMap in="SourceGraphic" scale="38" /></filter></svg>
        <i className="in-wash in-w1" /><i className="in-wash in-w2" />
        <i className="in-blot" />
        <svg className="in-hills in-far" viewBox="0 0 1200 300" preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false">
          <defs>
            <linearGradient id="in-fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity="1" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient>
          </defs>
          <path d={INK_FAR} fill="url(#in-fade)" />
        </svg>
        <svg className="in-hills in-near" viewBox="0 0 1200 300" preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false"><path d={INK_NEAR} fill="url(#in-fade)" /></svg>
        <i className="in-bird in-bd1" /><i className="in-bird in-bd2" />
        <div className="in-col">
          <Chars text={t.title} className="in-title" />
          {t.inscription && <Chars text={t.inscription} className="in-note" />}
          <div className="in-seal"><span data-text="小" /><span data-text="说" /></div>
        </div>
        <svg className="in-brush" viewBox="0 0 300 50" aria-hidden="true" focusable="false"><path pathLength={1} d="M6 30 C62 8, 104 44, 160 24 S242 11, 294 22" /></svg>
        <div className="in-ink-drops">{[0, 1, 2].map((i) => <i key={i} style={vars({ "--i": i })} />)}</div>
        {/* 近景：右上角伸进来一枝松，枝干一笔染出，松针一簇簇点上 */}
        <svg className="in-pine" viewBox="0 0 300 160" aria-hidden="true" focusable="false">
          <path className="in-pine-branch" pathLength={1} d={PINE_BRANCH} />
          {PINE_TUFTS.map(([x, y], i) => <g key={i} transform={`translate(${x} ${y})`}><g className="in-pine-tuft" style={vars({ "--i": i })}>
            {[-70, -45, -20, 5, 30, 55].map((a) => <path key={a} d="M0 0 L0 -22" transform={`rotate(${a})`} />)}
          </g></g>)}
        </svg>
        {/* 待机：一滴墨落在纸上，慢慢晕开、淡去 */}
        <div className="bs-idle in-idle"><i /></div>
      </div>

      {/* 复古：一张横格稿纸从滚筒后面卷上来；打字机在中间一个字一个字敲出书名（敲字的位置不动，纸带着字往左挪一格），敲完滑架回位、划一道短线；
          纸往上进一行，再敲出“第一章”，最后在右下角盖一个“初稿”红戳。--re-n / --re-n2 是两行的字数。 */}
      <div className="bs-scene" data-scene="retro" style={vars({ "--re-n": len(t.title), "--re-n2": len(t.chapter) })}>
        <div className="re-atmos">
          <i className="re-lamp" />
          {Array.from({ length: 9 }, (_, i) => <i key={i} className="re-dust" style={vars({ "--x": `${(i * 41 + 11) % 88}%`, "--y": `${(i * 29 + 18) % 62}%`, "--i": i })} />)}
        </div>
        <div className="re-story re-story-left"><div className="re-card-float">
          <span className="re-card-title" data-text={t.characters} />
          <div className="re-card-map"><i /><i /><i /><b /><b /></div>
          <span className="re-card-note" data-text={t.conflict} />
        </div></div>
        <div className="re-story re-story-right"><div className="re-card-float">
          <span className="re-card-title" data-text={t.world} />
          <div className="re-card-map re-card-world"><i /><i /><i /><b /><b /></div>
          <span className="re-card-note" data-text={t.clues} />
        </div></div>
        <div className="re-leaves">{[0, 1, 2, 3].map((i) => <i key={i} style={vars({ "--i": i })} />)}</div>
        <div className="re-chassis"><i className="re-spool re-spool-l" /><i className="re-spool re-spool-r" /><i className="re-ribbon" /></div>
        <div className="re-slot"><div className="re-sheet">
          <div className="re-feed">
            <div className="re-line"><div className="re-carriage"><Chars text={t.title} className="re-title" /></div></div>
            <i className="re-rule" />
            <div className="re-line re-line-2"><div className="re-carriage"><Chars text={t.chapter} className="re-title" /></div></div>
          </div>
          <span className="re-stamp" data-text={t.draft} />
        </div></div>
        <i className="re-roller" />
        <i className="re-guide" />
        {/* 待机：滑架右端的小铃，等一会儿就“叮”地晃一下 */}
        <div className="bs-idle re-idle"><i className="re-bell" /><b /><b /></div>
        <div className="re-marginalia"><span data-text={t.idea} /><i /><span data-text={t.characters} /></div>
        <div className="re-keys">
          {[10, 9, 7].map((count, row) => <div key={row} className="re-key-row">
            {Array.from({ length: count }, (_, i) => <i key={i} style={vars({ "--i": row * 10 + i })} />)}
          </div>)}
        </div>
      </div>

      {/* 极简：四角先落下裁切线，一条细线从左往右画过去，蓝色方块跟着线头走、停在线尾；书名一个字一个字出现在线上（偏左），
          线下一行小字，右边三道刻度。 */}
      <div className="bs-scene" data-scene="minimal">
        <i className="mn-crop mn-tl" /><i className="mn-crop mn-tr" /><i className="mn-crop mn-bl" /><i className="mn-crop mn-br" />
        <div className="mn-box">
          <Chars text={t.title} className="mn-title" />
          <i className="mn-line" /><i className="mn-dot" />
          <div className="mn-foot"><span className="mn-tag" data-text={t.tagline} /><span className="mn-ticks">{[0, 1, 2].map((i) => <i key={i} style={vars({ "--i": i })} />)}</span></div>
        </div>
        <div className="mn-pages">{[0, 1, 2].map((i) => <i key={i} style={vars({ "--i": i })} />)}</div>
        <i className="mn-fold" />
        {/* 底边一把刻度尺：刻度从左往右依次落下 */}
        <div className="mn-ruler">{Array.from({ length: 25 }, (_, i) => <i key={i} style={vars({ "--i": i })} />)}</div>
        {/* 待机：线尾的蓝色方块在三道刻度之间来回跳，像节拍器 */}
        <i className="bs-idle mn-idle" />
      </div>
    </>
  );
}
