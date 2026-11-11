"""启动页：打开软件、服务还没起来的这段时间显示。画面就是网页里各风格的启动动画（同一份场景和样式，由 frontend/scripts/build-splash.mjs
导出到 splash_assets.json），但不按固定时长播放，而是跟着数据库、后端服务、写作界面的真实启动进度走。

每个服务只在真正到达某一步时才推进对应进度（services.py 的 milestones），两步之间按上次启动记下的耗时（startup_timing.py）平滑往前走，
停在下一步之前等它；加载每往前走一点，当前主题自己的场景动画就跟着往后放一点，不再额外显示通用进度条。全部就绪后放该风格的退场，再进入写作界面。

app.py 调用：beginSplash() 服务开始启动；setStep('db'|'api'|'ui', n) 某个服务到达第 n 步；finishSplash() 全部就绪，返回还要等多少毫秒再切页。
#msg 是仅供读屏软件读取的状态文字。错误页 ERROR_HTML 在文件末尾。
"""

from __future__ import annotations

import html
import json
import re
from functools import lru_cache
from pathlib import Path

from .look import Look
from .startup_timing import DEFAULTS as DEFAULT_TIMING

ASSETS = Path(__file__).with_name("splash_assets.json")
# 网页报来的六种颜色对应的主题变量；预设配色由素材里的 palette 按 data-look 提供，这几项再按记录覆盖（自定义配色也能对上）。
COLOR_VARS = {"background": "--background", "foreground": "--foreground", "muted": "--color-muted",
              "accent": "--color-accent", "border": "--color-border", "surface": "--color-surface"}
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
_PLACEHOLDER = re.compile(r"__([A-Z]+)__")


@lru_cache(maxsize=1)
def _assets() -> dict:
    try:
        data = json.loads(ASSETS.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) and isinstance(data.get("scenes"), dict) else {}
    except (OSError, ValueError):
        return {}  # 素材丢失时保留空白启动页，不影响启动


SPLASH_HTML = """<!doctype html><html lang="zh-CN" data-look="__LOOK__" class="__DARK__" style="__STYLE__"><head><meta charset="utf-8"><title>__TITLE__</title>
<style>__PALETTE__</style><style>:root{--app-font-sans:"Microsoft YaHei UI","Microsoft YaHei","Segoe UI",sans-serif;--app-font-mono:"Cascadia Code",Consolas,monospace;--app-font-display:var(--app-font-sans)}</style>
<style>__CSS__</style><style>
html,body{margin:0;height:100%;overflow:hidden;background:var(--background,#060a13);color:var(--foreground,#dbe7ff);font-family:var(--app-font-sans)}
body::before,body::after{content:none!important}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
/* 启动页上没有固定的退场时刻：去掉网页版的兜底淡出，退场由 finishSplash 触发。 */
.boot-screen:not([data-phase="leaving"]){animation:none}
/* 背景小动静不归加载进度管，场景暂时停住时也仍有轻微环境运动。 */
.ambient{z-index:2147483100}.boot-screen[data-phase="leaving"]~.ambient{opacity:0;transition:opacity .4s}
/* 等得久了才露出的一行说明（真实的等待秒数），平时只给读屏软件。 */
#wait{position:fixed;left:0;right:0;bottom:14px;z-index:2147483200;margin:0;text-align:center;font-size:12px;letter-spacing:.04em;
color:var(--color-muted,#8aa0c4);opacity:0;transition:opacity .6s;pointer-events:none}
#wait.show{opacity:.85}.boot-screen[data-phase="leaving"]~#wait{opacity:0}
</style></head><body>
<h1 class="sr-only">__TITLE__</h1>
<div class="boot-screen" data-phase="visible" data-lang="zh" aria-hidden="true">__SCENE__</div>
<div class="ambient" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
<p id="msg" class="sr-only" role="status">正在启动…</p><p id="wait" aria-live="polite"></p>
<script>(function(){
var C=__CONFIG__,K=['db','api','ui'],REDUCE=matchMedia('(prefers-reduced-motion: reduce)').matches;
var screen=document.querySelector('.boot-screen');
/* 场景里一次性的动画（入场、生长、打字……）全部暂停，由进度来定它们的当前时刻。
   无限循环的小动画（光标闪、萤火、茶的热气……）自己播放，但带开始延迟的那些要等进度推到它们出场的时刻才开始，
   不然场景还停在开头，后面才该出现的花粉、水纹就已经在动了。待机小动画（.bs-idle）没有延迟，一直自己转。 */
var A=[],L=[];
try{(screen.getAnimations?screen.getAnimations({subtree:true}):[]).forEach(function(a){var t=a.effect&&a.effect.getComputedTiming?a.effect.getComputedTiming():null;
if(!t)return;if(isFinite(t.endTime)){a.pause();a.currentTime=0;A.push([a,t.endTime])}
else{var d=a.effect.getTiming().delay||0;if(d>0&&!REDUCE){a.pause();a.currentTime=0;L.push([a,d])}}})}catch(e){}
var span=C.show,t0=null,leaving=false,S={},shown={};
K.forEach(function(k){S[k]={n:0,at:0};shown[k]=0});
function scrub(p){screen.style.setProperty("--boot-progress",p.toFixed(4));var t=REDUCE?1e9:span*p;for(var i=0;i<A.length;i++){try{A[i][0].currentTime=Math.min(t,A[i][1])}catch(e){}}
for(var j=L.length-1;j>=0;j--){if(t>=L[j][1]){try{L[j][0].currentTime=t;L[j][0].play()}catch(e){}L.splice(j,1)}}}
function target(k,now){var e=C.expected[k],s=S[k],N=e.length;if(s.n>=N)return 1;if(t0===null)return 0;
var prev=s.n?e[s.n-1]:0,gap=Math.max(200,e[s.n]-prev),ratio=Math.max(0,now-t0-s.at)/gap;
/* 到预计时刻前匀速走完这一段的九成，之后越来越慢，停在下一步之前，绝不提前越过还没到的那一步 */
var f=ratio<1?0.9*ratio:0.9+0.08*(1-Math.exp(-(ratio-1)));return (s.n+f)/N}
var W=K.map(function(k){return C.expected[k][C.expected[k].length-1]}),Wsum=W.reduce(function(a,b){return a+b},0);
function overall(){var v=0;K.forEach(function(k,i){v+=shown[k]*W[i]});return v/Wsum}
var last=performance.now();
function frame(now){var dt=Math.min(100,now-last);last=now;var wall=Date.now();
K.forEach(function(k){var g=target(k,wall),rate=S[k].n>=C.expected[k].length?0.012:0.006;shown[k]+=(g-shown[k])*(1-Math.exp(-rate*dt));if(g-shown[k]<0.002)shown[k]=g});
if(!leaving){scrub(overall());requestAnimationFrame(frame)}}
requestAnimationFrame(frame);
window.beginSplash=function(){if(t0===null)t0=Date.now()};
window.setStep=function(k,n){if(!S[k])return;if(t0===null)t0=Date.now();if(n>S[k].n){S[k].n=Math.min(n,C.expected[k].length);S[k].at=Date.now()-t0}};
/* 全部就绪：三条进度很快补满，场景放到成型那一帧，再放该风格的退场。返回从现在到退场结束的毫秒数，Python 等这么久再切到写作界面。 */
window.finishSplash=function(){K.forEach(function(k){S[k].n=C.expected[k].length});if(leaving)return 0;
var catchUp=REDUCE?0:Math.round(260+(1-overall())*900),leave=REDUCE?300:C.leave;
setTimeout(function(){K.forEach(function(k){shown[k]=1});scrub(1);leaving=true;screen.dataset.phase='leaving'},catchUp);
return catchUp+leave};
/* 进度一时不往前走（等数据库、等后端打出下一步）：1.5 秒内几乎没动就给场景加 data-idle，各风格的待机小动作（.bs-idle）淡入，
   小猫打盹、纸边画圈、打字机摇铃……让人知道还在干活；进度再动起来就淡出。 */
var hist=[];
setInterval(function(){if(leaving){delete screen.dataset.idle;return}var now=Date.now(),p=overall();hist.push([now,p]);
while(hist.length&&now-hist[0][0]>1500)hist.shift();
var still=hist.length>2&&now-hist[0][0]>1200&&p-hist[0][1]<0.006;
if(still)screen.dataset.idle='1';else delete screen.dataset.idle},250);
var waited=Date.now();setInterval(function(){var s=Math.floor((Date.now()-waited)/1000),w=document.getElementById('wait');
if(s>=12&&!leaving){w.textContent='已等待 '+s+' 秒，首次启动或电脑较忙时会慢一些';w.className='show'}},1000);
})();</script></body></html>"""


def render_splash(title: str, look: Look, timing: dict[str, list[int]] | None = None) -> str:
    """按保存的风格画启动页。风格名不在素材里时（例如旧记录）按科技风格画；颜色只收 #rrggbb；书名转义。
    所有占位符一次替换完，书名、素材里即使含有 __X__ 样的文字也不会被当成占位符。"""
    assets = _assets()
    timing_table = assets.get("timing") or {}
    look_id = look.look if look.look in timing_table else "tech"
    style = ";".join(f"{COLOR_VARS[key]}:{value.lower()}" for key, value in look.colors.items()
                     if key in COLOR_VARS and isinstance(value, str) and _HEX.match(value))
    plan = timing_table.get(look_id) or {"show": 3300, "leave": 700}
    config = {"show": plan["show"], "leave": plan["leave"], "expected": timing or DEFAULT_TIMING}
    values = {
        "LOOK": look_id, "DARK": "dark" if look.dark else "", "STYLE": style, "TITLE": html.escape(title),
        "PALETTE": assets.get("palette", ""), "CSS": assets.get("css", ""), "SCENE": (assets.get("scenes") or {}).get("zh", ""),
        "CONFIG": json.dumps(config).replace("<", "\\u003c"),
    }
    return _PLACEHOLDER.sub(lambda match: values.get(match.group(1), match.group(0)), SPLASH_HTML)


ERROR_HTML = """<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:32px;min-height:100vh;font-family:"Microsoft YaHei UI","Microsoft YaHei",sans-serif;color:#dbe7ff;
background:radial-gradient(ellipse at 50% 0,#1a1030 0,#070b14 60%)}
h2{margin:0 0 12px;color:#fb7185;font-weight:600;letter-spacing:.06em}
p{color:#8aa0c4;line-height:1.7}
code{color:#22d3ee;background:#0d1424;padding:1px 6px;border-radius:4px}
button{padding:6px 14px;font-size:13px;cursor:pointer;color:#22d3ee;background:transparent;border:1px solid #22d3ee;border-radius:8px}
button:hover{background:rgba(34,211,238,.12)}
pre{background:#050810;color:#c8d6f0;padding:14px;border:1px solid #1c2a44;border-radius:10px;
max-height:50vh;overflow:auto;white-space:pre-wrap;font-size:12px;user-select:text}
</style></head><body><h2>启动失败</h2><p>__MESSAGE__</p>
<p>日志目录：<code>__LOGDIR__</code> <button onclick="pywebview.api.open_logs()">打开日志目录</button></p>
<pre>__TAIL__</pre><p>处理后关闭此窗口，再重新打开客户端。</p></body></html>"""
