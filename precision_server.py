#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
precision_server.py
-----------------------------------------------------------------------------
高精度数学求值 / 方程求根服务 (Python 后端, 基于 mpmath)
- 仅依赖 Python 标准库 + mpmath(可选, 强烈推荐安装)
- 默认 50 位有效数字, 可通过 precision 字段指定
- 提供 HTTP JSON 接口, 跨域已开启 (CORS)

启动:
    pip install mpmath
    python precision_server.py            # 默认 127.0.0.1:8765
    python precision_server.py 9000       # 自定义端口

接口:
    GET  /health        健康检查, 返回 {status, mpmath, precision}
    POST /evaluate      求值
        body: {"expression":"...", "variables":{...}, "precision":50}
        resp: {"result": "3.14159265358979323846..."}
    POST /solve         方程求根 (f(x)=0 或 f(x)=g(x))
        body: {
            "expression":"x^2 - 4",
            "variable":"x",
            "options":{"start":-100,"end":100,"samples":500,
                       "epsilon":"1e-30","precision":50}
        }
        resp: {"roots":["-2.0","2.0"]}
    POST /limit         数值极限 lim_{var->point} expr
        body: {
            "expression":"(1 + 1/x)^x",
            "variable":"x",
            "point":"inf",
            "precision":50
        }
        resp: {"result": "2.7182818284590452353602874713526624977572470936999595..."}
-----------------------------------------------------------------------------
"""
import ast
import json
import operator
import re
import sys
import traceback
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

# ---------- mpmath (可选) ----------
def _cbrt(x):
    return x ** (mpf(1) / mpf(3)) if HAS_MPMATH else x ** (1.0 / 3.0)

try:
    from mpmath import (
        mp, mpf, sin, cos, tan,
        asin, acos, atan, atan2,
        sinh, cosh, tanh,
        exp, log, log10, sqrt, power,
        limit,
        pi, e, phi, inf, nan,
        floor as mpfloor, ceil as mpceil
    )
    tau = 2 * pi  # mpmath 没有内置 tau
    HAS_MPMATH = True
    try:
        from mpmath import cbrt  # mpmath >= 1.2
    except ImportError:
        def cbrt(x): return x ** (mpf(1) / mpf(3))
except Exception as _ex:
    print("[mpmath import failed]", repr(_ex), file=sys.stderr)
    HAS_MPMATH = False
    cbrt = _cbrt
    def mpf(x): return float(x)
    def pi(): return 3.141592653589793
    def e(): return 2.718281828459045
    def tau(): return 6.283185307179586
    def phi(): return 1.618033988749895

DEFAULT_PRECISION = 50

# ---------- mpmath 环境 ----------
_MP_CONSTANTS = {}
_MP_FUNCTIONS = {}

def setup_mpmath(precision):
    if not HAS_MPMATH:
        return
    mp.dps = precision
    _MP_CONSTANTS.update({
        "pi": pi, "PI": pi,
        "e": e, "E": e,
        "tau": tau, "TAU": tau,
        "phi": phi, "PHI": phi,
        "inf": inf, "Inf": inf, "INF": inf,
        "nan": nan, "NaN": nan, "NAN": nan,
    })
    _MP_FUNCTIONS.update({
        "sin": sin, "cos": cos, "tan": tan,
        "asin": asin, "acos": acos, "atan": atan, "atan2": atan2,
        "sinh": sinh, "cosh": cosh, "tanh": tanh,
        "exp": exp, "log": log, "ln": log, "log10": log10,
        "log2": lambda x: log(x) / log(2),
        "sqrt": sqrt, "cbrt": cbrt,
        "abs": abs, "pow": power,
        "floor": mpfloor, "ceil": mpceil,
        "min": min, "max": max,
        "fact": _factorial,
    })

def _factorial(n):
    if n < 0 or n != int(n):
        raise ValueError("fact() requires non-negative integer")
    r = 1
    for i in range(2, int(n) + 1):
        r *= i
    return r

# ---------- AST 求值 ----------
_BIN = {
    ast.Add: operator.add, ast.Sub: operator.sub,
    ast.Mult: operator.mul, ast.Div: operator.truediv,
    ast.Mod: operator.mod, ast.Pow: operator.pow,
    ast.FloorDiv: operator.floordiv,
}
_UNARY = {ast.UAdd: operator.pos, ast.USub: operator.neg}

def _eval(node, env):
    if isinstance(node, ast.Constant):
        if isinstance(node.value, bool):
            return mpf(1 if node.value else 0)
        if isinstance(node.value, int):
            return mpf(node.value)
        if isinstance(node.value, float):
            # ★ 关键: 走字符串通道, 让 mpf 按当前精度精确解析
            #   mpf(0.1)   -> 0.10000000000000000555... (Python float 已失精)
            #   mpf('0.1') -> 0.1 (按当前精度精确解析)
            return mpf(repr(node.value))
        raise ValueError("unsupported constant: %r" % (node.value,))
    if hasattr(ast, "Num") and isinstance(node, ast.Num):  # py<3.8
        # Num 节点的 n 可能是 int 或 float, float 也要走字符串
        if isinstance(node.n, float):
            return mpf(repr(node.n))
        return mpf(node.n)
    if isinstance(node, ast.Name):
        if node.id in env:
            return env[node.id]
        if node.id in _MP_FUNCTIONS:
            return _MP_FUNCTIONS[node.id]
        raise ValueError("unknown name: " + node.id)
    if isinstance(node, ast.BinOp):
        op = _BIN.get(type(node.op))
        if op is None:
            raise ValueError("unsupported operator: " + type(node.op).__name__)
        return op(_eval(node.left, env), _eval(node.right, env))
    if isinstance(node, ast.UnaryOp):
        op = _UNARY.get(type(node.op))
        if op is None:
            raise ValueError("unsupported unary: " + type(node.op).__name__)
        return op(_eval(node.operand, env))
    if isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name):
            raise ValueError("only direct function calls are supported")
        fname = node.func.id
        # ★ 内部通道: __mpf__(字符串) -> mpf 字符串解析 (任意精度, 不丢 1e114514)
        if fname == "__mpf__":
            if len(node.args) != 1 or not isinstance(node.args[0], ast.Constant):
                raise ValueError("__mpf__() requires a single string literal")
            return mpf(node.args[0].value)
        fn = _MP_FUNCTIONS.get(fname)
        if fn is None:
            raise ValueError("unknown function: " + fname)
        return fn(*[_eval(a, env) for a in node.args])
    raise ValueError("unsupported node: " + type(node).__name__)

# ---------- 表达式求值 ----------
def _caret_to_pow(src):
    """把 'a^b' 翻译为 'a**b'. Python 的 ^ 是异或, 前端 ^ 的语义是乘方."""
    out = []
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if c == "^":
            out.append("**")
            i += 1
        else:
            out.append(c)
            i += 1
    return "".join(out)


# 数字字面量 (整数/小数/科学计数法) 的精确正则.
#   不能用 ast.parse 后再改 value, 因为 1e114514 已经被 Python 转成 inf(float).
#   必须在 ast.parse 之前, 把数字字面量包成 __mpf__("...") 函数调用,
#   这样 _eval 看到的是字符串 '1e114514', mpf('1e114514') 是任意精度的 mpf.
#   ★ 注意: 捕获组必须包含整个数字字面量 (含可选科学计数法), 否则
#     sub 替换时 \1 会漏掉 e114514 部分, 1e114514 被切成 1 + e114514.
_NUMBER_RE = re.compile(
    r"(?<![\w\.])"                            # 前面不是 word char / .
    r"([+\-]?(?:\d+\.?\d*|\.\d+)"             # 整数/小数 (可带正负号)
    r"(?:[eE][+\-]?\d+)?)"                    # 可选科学计数法 (含在捕获组内)
    r"(?![\w\.])"                             # 后面不是 word char / .
)


def _wrap_numbers_as_mpf(expr):
    """把表达式里的所有数字字面量替换为 __mpf__('...') 函数调用.

    例如: "1e114514" -> "__mpf__('1e114514')"
          "1.5e-10"  -> "__mpf__('1.5e-10')"
          "2"        -> "__mpf__('2')"
          "1/3"      -> "__mpf__('1')/__mpf__('3')"

    注意: _insert_implicit_mul 必须在 _wrap_numbers_as_mpf 之后调用,
    否则 2x 会被误包成 __mpf__('2x').
    """
    return _NUMBER_RE.sub(r"__mpf__('\1')", expr)

def _insert_implicit_mul(src):
    """在 token 之间按需插入 *. 例外: 函数调用 NAME( 不插."""
    import io
    import tokenize as _tok

    if not src.strip():
        return src
    # tokenize 需要以 \n 结尾, 用 bytes 避开 BOM 检测问题
    text = (src if src.endswith("\n") else src + "\n").encode("utf-8")
    try:
        toks = list(_tok.tokenize(io.BytesIO(text).readline))
    except _tok.TokenError:
        return src

    SKIP = (_tok.ENCODING, _tok.NL, _tok.NEWLINE, _tok.INDENT,
            _tok.DEDENT, _tok.COMMENT, _tok.ENDMARKER)
    REAL = [t for t in toks if t.type not in SKIP]

    def is_start(t):
        if t.type == _tok.NUMBER: return True
        if t.type == _tok.NAME: return True
        if t.type == _tok.OP and t.string == "(": return True
        return False

    def is_end(t):
        if t.type == _tok.NUMBER: return True
        if t.type == _tok.NAME: return True
        if t.type == _tok.OP and t.string == ")": return True
        return False

    out = []
    for i, t in enumerate(REAL):
        if i > 0 and is_end(REAL[i - 1]) and is_start(t):
            if t.type == _tok.OP and t.string == "(" and REAL[i - 1].type == _tok.NAME:
                pass  # 函数调用
            else:
                out.append("*")
        out.append(t.string)
    return "".join(out)

def evaluate_expression(expr, variables, precision):
    if not HAS_MPMATH:
        raise RuntimeError(
            "mpmath is not installed. Run: pip install mpmath"
        )
    setup_mpmath(precision)
    expr = _wrap_numbers_as_mpf(expr)   # ★ 先包数字字面量, 防 1e114514 变 inf
    expr = _insert_implicit_mul(expr)  # 隐式乘法 2x / (a)(b)
    expr = _caret_to_pow(expr)         # 前端 ^  =>  Python **
    env = dict(_MP_CONSTANTS)
    if variables:
        for k, v in variables.items():
            # ★ 同样: float 走 repr/str, 让 mpf 按当前精度精确解析
            if isinstance(v, float):
                env[k] = mpf(repr(v))
            elif isinstance(v, int):
                env[k] = mpf(v)
            else:
                # 字符串等, 交给 mpf 自己处理
                env[k] = mpf(v)
    tree = ast.parse(expr, mode="eval")
    return _eval(tree.body, env)

# ---------- 方程求根 ----------
def _to_equation_ast(expr):
    """把 'f = g' 改写为 '(f) - (g)' 的源码 (字符串)"""
    if "=" not in expr:
        return expr
    if expr.count("=") > 1:
        raise ValueError("equation must have at most one '='")
    lhs, rhs = expr.split("=", 1)
    return "((%s) - (%s))" % (lhs.strip(), rhs.strip())

def solve_equation(expr, variable, start, end, samples, epsilon, precision, variables=None):
    if not HAS_MPMATH:
        raise RuntimeError("mpmath is not installed. Run: pip install mpmath")
    setup_mpmath(precision)
    expr = _to_equation_ast(expr)
    expr = _insert_implicit_mul(expr)  # 隐式乘法
    expr = _caret_to_pow(expr)         # 前端 ^  =>  Python **
    tree = ast.parse(expr, mode="eval")
    env = dict(_MP_CONSTANTS)
    if variables:
        for k, v in variables.items():
            # ★ 同样: float 走 repr 保持精度
            if isinstance(v, float):
                env[k] = mpf(repr(v))
            elif isinstance(v, int):
                env[k] = mpf(v)
            else:
                env[k] = mpf(v)

    def f(x):
        env[variable] = x
        return _eval(tree.body, env)

    eps = mpf(epsilon)
    start = mpf(start); end = mpf(end)
    step = (end - start) / samples
    xs = [start + i * step for i in range(samples + 1)]
    fs = []
    for x in xs:
        try:
            fs.append(f(x))
        except Exception:
            fs.append(mpf("nan"))

    # 去重阈值: 用 mpf 精度推出合理值, 但不要过小
    # 默认 samples=500, 步长 ~0.4; 1e-10 * (1+|r|) 通常够好
    dedup_eps = eps * 100 if eps * 100 > mpf("1e-10") else mpf("1e-10")

    roots = []
    seen = []

    def add(r):
        if r != r:  # NaN
            return
        for s in seen:
            if abs(s - r) < dedup_eps * (1 + abs(r)):
                return
        seen.append(r)
        roots.append(r)

    # 0) 找 |f| 局部极小 -> 重根 (切根) 候选
    max_abs_f = max(abs(f) for f in fs if f == f) or mpf("1")
    for i in range(1, samples):
        a, b, c = abs(fs[i - 1]), abs(fs[i]), abs(fs[i + 1])
        if b <= a and b <= c and b < max_abs_f * mpf("1e-6") and b < eps * mpf("1e6"):
            add(xs[i])

    # 0.5) 重根深度检测: 对 |f| 较小的连通区域用黄金分割法找 |f| 极小
    small_thresh = max(max_abs_f * mpf("1e-4"), eps * mpf("1e3"))
    k = 0
    while k <= samples:
        if fs[k] != fs[k] or abs(fs[k]) > small_thresh:
            k += 1; continue
        j = k
        while j <= samples and fs[j] == fs[j] and abs(fs[j]) <= small_thresh:
            j += 1
        if j - k >= 2:
            lo, hi = xs[k], xs[min(j, samples)]
            flo, fhi = fs[k], fs[j - 1]
            if flo * fhi >= 0:
                # 不变号 -> 重根, 黄金分割找 |f| 极小
                gr = (mpf(5).sqrt() - 1) / 2
                a_lo, a_hi = lo, hi
                c = a_hi - gr * (a_hi - a_lo)
                d = a_lo + gr * (a_hi - a_lo)
                try: fc = abs(f(c))
                except Exception: fc = mpf("nan")
                try: fd = abs(f(d))
                except Exception: fd = mpf("nan")
                for _ in range(80):
                    if a_hi - a_lo < eps * max(1, abs(a_hi)):
                        break
                    if fc < fd:
                        a_hi, d, fd = d, c, fc
                        c = a_hi - gr * (a_hi - a_lo)
                        try: fc = abs(f(c))
                        except Exception: fc = mpf("nan")
                    else:
                        a_lo, c, fc = c, d, fd
                        d = a_lo + gr * (a_hi - a_lo)
                        try: fd = abs(f(d))
                        except Exception: fd = mpf("nan")
                r = (a_lo + a_hi) / 2
                try:
                    if abs(f(r)) < small_thresh:
                        add(r)
                except Exception:
                    pass
        k = j

    # 1) 变号区间 -> 二分 (保证在 [start, end] 内)
    for i in range(samples):
        a, b = xs[i], xs[i + 1]
        fa, fb = fs[i], fs[i + 1]
        if fa != fa or fb != fb:
            continue
        if abs(fa) < eps:
            add(a); continue
        if fa * fb < 0:
            lo, hi = a, b
            flo, fhi = fa, fb
            for _ in range(200):
                mid = (lo + hi) / 2
                try:
                    fmid = f(mid)
                except Exception:
                    break
                # ★ 修复: 不能用 abs(fmid) < eps 作为收敛判据!
                #   对 x+1=2 这种线性方程, mid 接近根时 f(mid) 会很小 (1e-49),
                #   但 mid 本身可能仍有 1e-49 量级误差, 并不是真根.
                #   改用 (hi - lo) < eps 作为主判据, 让区间宽度逼近 mpf 精度极限.
                if (hi - lo) < eps:
                    add(mid); break
                if flo * fmid < 0:
                    hi, fhi = mid, fmid
                else:
                    lo, flo = mid, fmid

    # 2) 牛顿法仅作精化 (从已找到的根出发, 不再寻找新区间, 避免飞出去)
    refined = []
    for r in roots:
        x = r
        for _ in range(50):
            try:
                fx = f(x)
            except Exception:
                break
            # ★ 修复: 收敛判据改严, 避免 1e-30 量级假收敛
            if abs(fx) < eps * eps:
                break
            h = mpf("1e-10") * max(1, abs(x))
            try:
                fxp = f(x + h); fxm = f(x - h)
            except Exception:
                break
            if fxp != fxp or fxm != fxm:
                break
            deriv = (fxp - fxm) / (2 * h)
            if abs(deriv) < mpf("1e-40"):
                break
            x_new = x - fx / deriv
            # ★ 修复: 步长判据改严, 要求 abs(diff) < eps/10, 留出足够精度余量
            if abs(x_new - x) < eps / 10:
                x = x_new; break
            x = x_new
        try:
            f_final = abs(f(x))
            f_old = abs(f(r))
            refined.append(x if f_final <= f_old else r)
        except Exception:
            refined.append(r)

    # 3) 排序并按 dedup 再次清理
    refined.sort()
    out = []
    for r in refined:
        if not out or abs(out[-1] - r) >= dedup_eps * (1 + abs(r)):
            out.append(r)
    return out

# ---------- 数值极限 ----------
def compute_limit(expr, variable, point, precision):
    """数值极限: 用 mpmath.limit 走任意精度 Richardson/Shanks 加速

    expr:    字符串,  例 "(1 + 1/x)^x"  或  "(2x + exp(4*x))^(1/x)"
    variable: 字符串, 例 "x"
    point:   字符串/数值, 接受 "0"  "1.5"  "inf"  "-inf"  "nan"
    precision: 整数 dps
    """
    if not HAS_MPMATH:
        raise RuntimeError("mpmath is not installed. Run: pip install mpmath")
    setup_mpmath(precision)
    expr = _wrap_numbers_as_mpf(expr)   # ★ 防 1e114514 变 inf
    expr = _insert_implicit_mul(expr)  # 隐式乘法
    expr = _caret_to_pow(expr)         # 前端 ^  =>  Python **
    tree = ast.parse(expr, mode="eval")
    env = dict(_MP_CONSTANTS)

    def f(x):
        env[variable] = x
        return _eval(tree.body, env)

    # 把 point 解释为 mpf (支持 inf/-inf/nan)
    pt = mpf(point)
    # mpmath.limit 默认 direction=+1 (从右侧接近);
    # point 有限时单侧即可, 双向也得到同样答案.
    return limit(f, pt)
class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length).decode("utf-8") if length else "{}"
        return json.loads(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path == "/health" or self.path.startswith("/health?"):
            self._send_json({
                "status": "ok",
                "mpmath": HAS_MPMATH,
                "precision": mp.dps if HAS_MPMATH else None,
            })
        else:
            self._send_json({"error": "not found"}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            data = self._read_json()
            if path == "/evaluate":
                result = evaluate_expression(
                    data.get("expression", ""),
                    data.get("variables") or {},
                    int(data.get("precision", DEFAULT_PRECISION)),
                )
                self._send_json({"result": str(result)})

            elif path == "/solve":
                opts = data.get("options", {})
                roots = solve_equation(
                    data.get("expression", ""),
                    data.get("variable", "x"),
                    float(opts.get("start", -100)),
                    float(opts.get("end",   100)),
                    int(opts.get("samples", 500)),
                    str(opts.get("epsilon", "1e-30")),
                    int(opts.get("precision", DEFAULT_PRECISION)),
                    variables=opts.get("variables") or {}
                )
                self._send_json({"result": [str(r) for r in roots]})

            elif path == "/limit":
                result = compute_limit(
                    data.get("expression", ""),
                    data.get("variable", "x"),
                    str(data.get("point", "0")),
                    int(data.get("precision", DEFAULT_PRECISION))
                )
                self._send_json({"result": str(result)})

            else:
                self._send_json({"error": "not found"}, 404)

        except Exception as ex:
            self._send_json({"error": str(ex) + "\n" + traceback.format_exc()}, 400)

def main():
    port = 8765
    host = "127.0.0.1"
    if len(sys.argv) > 1:
        port = int(sys.argv[1])
    if len(sys.argv) > 2:
        host = sys.argv[2]

    if not HAS_MPMATH:
        print("=" * 60)
        print("[WARN] mpmath 未安装, 所有请求都会返回错误")
        print("       安装:  pip install mpmath")
        print("=" * 60)

    server = HTTPServer((host, port), Handler)
    print("Precision math server listening on http://%s:%d" % (host, port))
    print("  GET  /health")
    print("  POST /evaluate  {expression, variables, precision}")
    print("  POST /solve     {expression, variable, options}")
    print("  POST /limit     {expression, variable, point, precision}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.shutdown()

if __name__ == "__main__":
    main()
