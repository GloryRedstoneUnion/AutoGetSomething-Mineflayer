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
        asinh, acosh, atanh,
        exp, log, log10, sqrt, power,
        limit, quad, quadosc, nsum, nprod,
        pi, e, phi, inf, nan, isfinite,
        floor as mpfloor, ceil as mpceil
    )
    # r15: 加 gamma/erf (可选, 旧版 mpmath 可能没有)
    try:
        from mpmath import gamma as _mp_gamma
    except ImportError:
        _mp_gamma = None
    try:
        from mpmath import erf as _mp_erf
    except ImportError:
        _mp_erf = None
    # r13: NoConvergence 用于 limit(..., exp=True) 失败时回退到 exp=False
    try:
        from mpmath import NoConvergence
    except ImportError:
        # 旧版 mpmath 可能用 mp.libmp.NoConvergence
        from mpmath.libmp import NoConvergence
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
    class NoConvergence(Exception):
        pass

DEFAULT_PRECISION = 50

# ---------- mpmath 环境 ----------
_MP_CONSTANTS = {}
_MP_FUNCTIONS = {}

def setup_mpmath(precision):
    if not HAS_MPMATH:
        return
    # r15-amend9 (Bug 8.1): 不再在此设 mp.dps — ThreadingMixIn 下多线程并发请求
    #   会互相覆盖全局 mp.dps 导致 race. 改为每个 compute_* 函数内部用
    #   `with mp.workdps(precision):` 包裹计算逻辑, 退出时自动恢复.
    #   setup_mpmath 仅负责幂等更新 _MP_CONSTANTS / _MP_FUNCTIONS.
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
        # r15-amend10 (Bug 15): arctan/arcsin/arccos 等 arc* 别名 (LaTeX \arctan 等常见写法)
        "arcsin": asin, "arccos": acos, "arctan": atan, "arctan2": atan2,
        "arsinh": asinh, "arcosh": acosh, "artanh": atanh,
        "sinh": sinh, "cosh": cosh, "tanh": tanh,
        "exp": exp, "log": log, "ln": log, "log10": log10,
        "log2": lambda x: log(x) / log(2),
        "sqrt": sqrt, "cbrt": cbrt,
        "abs": abs, "pow": power,
        "floor": mpfloor, "ceil": mpceil,
        "min": min, "max": max,
        "fact": _factorial,
        # r15: 加 fac/binom/double_fact/gamma/erf
        "fac": _mp_fac,
        "factorial": _mp_fac,
        "double_fact": _double_fact,
        "dfact": _double_fact,
        "binom": _mp_binom,
    })
    if _mp_gamma is not None:
        _MP_FUNCTIONS["gamma"] = _mp_gamma
    if _mp_erf is not None:
        _MP_FUNCTIONS["erf"] = _mp_erf

def _factorial(n):
    if n < 0 or n != int(n):
        raise ValueError("fact() requires non-negative integer")
    r = 1
    for i in range(2, int(n) + 1):
        r *= i
    return r

# r15: 加 fac, binom, double_factorial, gamma (Γ), catalan (G) 等
def _mp_fac(n):
    """fac(n) = n! .  与 _factorial 区分: fac 是用户调用名."""
    return _factorial(n)

def _double_fact(n):
    """n!! = n * (n-2) * (n-4) * ... * (n or 2).  r15 用于 Wallis 公式 (题目 100)."""
    if n < 0 or n != int(n):
        raise ValueError("n!! requires non-negative integer")
    n = int(n)
    r = 1
    while n > 0:
        r *= n
        n -= 2
    return r

def _mp_binom(n, k):
    """binom(n, k) = n! / (k! * (n-k)!).  r15 用于 Catalan 公式 (题目 11)."""
    n_i = int(n) if n == int(n) else None
    k_i = int(k) if k == int(k) else None
    if n_i is None or k_i is None:
        raise ValueError("binom() requires integer arguments")
    if k_i < 0 or k_i > n_i:
        return mpf(0)
    # 用对数组合防 n 大时溢出
    if k_i > n_i - k_i:
        k_i = n_i - k_i
    r = 1
    for i in range(1, k_i + 1):
        r = r * (n_i - k_i + i) // i
    return mpf(r)

# ---------- 高阶函数: sum / product / integrate ----------
#   这些是 JS 端 evaluate 用的同名函数, Python 后端也要支持以便 limit
#   等高阶表达式能 evaluate 极限.
#
#   sum(k, lo, hi, body)    ->  Σ_{k=lo}^{hi} body
#   product(k, lo, hi, body) ->  Π_{k=lo}^{hi} body
#   integrate(f, x, a, b)   ->  ∫_a^b f(x) dx
#
#   body/f 是字符串, 循环时通过 ast 重新求值 (复制 env, 注入 k/x)

def _ast_eval_string(body_src, env):
    """对字符串 body_src 重新 ast.parse 并求值, 复制 env."""
    local_env = dict(env)
    expr2 = _wrap_numbers_as_mpf(body_src)
    expr2 = _insert_implicit_mul(expr2)
    expr2 = _caret_to_pow(expr2)
    expr2 = _doublebang_to_doublefact(expr2)  # r15: n!! => double_fact(n)
    expr2 = _singlebang_to_factorial(expr2)  # r15-amend10 (Bug 29): n! => factorial(n)
    tree2 = ast.parse(expr2, mode="eval")
    return _eval(tree2.body, local_env)

# r14: 给 _py_sum / _py_product 复用, 一次性解析 body 为 AST, 避免内层循环每次重 parse
#   性能关键: 嵌套 sum/product 嵌入 limit 时, mpmath.limit 调 f(k) k=1..N (N≈50-200),
#   每个 f(k) 内层 k 次 sum 迭代, 不缓存 AST 则 ast.parse 总次数 = 1+2+...+N ≈ N²/2,
#   在 N=200 时达 20100 次, 单次 ~100-500 μs, 总 2-10s 命中 JS 端 15s timeout.
#   进一步: 调用方 (_eval sum/product 分支) 直接传 AST node, 跳过 ast.unparse 一次.
def _coerce_body(body):
    """r14: 接受 str 或 ast.AST, 统一返回 ast.AST node."""
    if isinstance(body, ast.AST):
        return body
    if isinstance(body, str):
        return _parse_body_ast(body)
    raise TypeError("body must be str or ast.AST, got %s" % type(body).__name__)

def _parse_body_ast(body_src):
    """r14: 一次性把 body 字符串解析为 AST node, 给 sum/product 内层循环复用."""
    e = _wrap_numbers_as_mpf(body_src)
    e = _insert_implicit_mul(e)
    e = _caret_to_pow(e)
    e = _doublebang_to_doublefact(e)  # r15: n!! => double_fact(n)
    e = _singlebang_to_factorial(e)  # r15-amend10 (Bug 29): n! => factorial(n)
    return ast.parse(e, mode="eval").body

def _to_int_mpf(x):
    """把 mpf 转 int (要求是整数), 用于循环边界."""
    if x != int(x):
        raise ValueError("sum/product requires integer bounds (got %s)" % x)
    return int(x)

def _py_sum(var, lo, hi, body, env):
    lo_i = _to_int_mpf(lo); hi_i = _to_int_mpf(hi)
    if hi_i < lo_i:
        return mpf(0)
    # r14: 一次性解析 body 为 AST, inner loop 复用 (vs 之前每次迭代 ast.parse + ast.unparse)
    body_ast = _coerce_body(body)
    total = mpf(0)
    for i in range(lo_i, hi_i + 1):
        local_env = dict(env)
        local_env[var] = mpf(i)
        total += _eval(body_ast, local_env)
    return total

def _py_product(var, lo, hi, body, env):
    lo_i = _to_int_mpf(lo); hi_i = _to_int_mpf(hi)
    if hi_i < lo_i:
        return mpf(1)
    # r14: 同 _py_sum, 预解析 AST 避免内层重 parse
    body_ast = _coerce_body(body)
    total = mpf(1)
    for i in range(lo_i, hi_i + 1):
        local_env = dict(env)
        local_env[var] = mpf(i)
        total *= _eval(body_ast, local_env)
    return total

def _py_integrate(body, var, a, b, env):
    # 用 mpmath.quad 数值积分, 内部以 var 替换 body 中的 var
    def f(x):
        local_env = dict(env)
        local_env[var] = x
        return _ast_eval_string(body, local_env)
    # r15: 振荡积分 (sin/cos 在 [a,inf) 上) 走 quadosc 更精确
    #   例: ∫₀^∞ sin(x)/x dx = π/2,  ∫₀^∞ x*sin(x)/(1+x^2) dx = π/2 * 1/e
    #   普通 quad 截断到 ~50 处会给出错误结果 (7.31 而不是 π/2)
    if (b == inf or b == float('inf')) and _is_oscillatory(body):
        # r15-amend9 (Bug 4.1): 从 sin(k*x)/cos(k*x) 参数提取 omega, 不再硬编码 omega=1.
        #   对 sin(2*x) 等非单位频率振荡积分, omega=1 会给出错误结果.
        #   非线性参数 (如 sin(x^2) chirp) _extract_omega 返 None, 回退普通 quad.
        omega = _extract_omega(body)
        if omega is not None:
            try:
                return quadosc(f, [a, b], omega=omega)
            except Exception:
                pass  # 回退到 quad
    return quad(f, [a, b])

# r15: 简单判定积分体是否振荡
#   查找 sin( 或 cos( 后跟一个常数或 var
import re as _re
# 形式 1: sin(常数*x) 或 sin(x) (有 * 乘)
_OSC_PAT1 = _re.compile(r'\b(sin|cos)\s*\([^)]*\)')
# 形式 2: 单独的 sin(x) (无乘) - 在 [a,inf) 上也算振荡
# r15-amend10 (Bug 65): 1-cos(x) 形式不是振荡的 (1-cos >= 0, 不变号).
#   quadosc 对不变号的积分会 hang (找不到零点). 检测 1-cos / 1 - cos 模式.
#   注意: _wrap_numbers_as_mpf 会把 1 包成 __mpf__('1'), 所以也要匹配包装后的形式.
_NON_OSC_1MINUS_COS = _re.compile(r"(?:\b1\b|__mpf__\(['\"]1['\"]\))\s*-\s*cos\s*\(")
def _is_oscillatory(body):
    """简单判断 body 字符串中是否含 sin(...) 或 cos(...) (含形参), 视为振荡函数"""
    if not _OSC_PAT1.search(body):
        return False
    # r15-amend10 (Bug 65): 1-cos(x) 不变号 (>=0), quadosc 会 hang, 走普通 quad.
    if _NON_OSC_1MINUS_COS.search(body):
        return False
    return True

# r15-amend9 (Bug 4.1): 从 sin(k*x+c) / cos(k*x+c) 参数中提取 omega=k.
#   非线性参数 (如 x^2 chirp) 返 None, 回退普通 quad.
_OMEGA_ARG_RE = _re.compile(r'\b(sin|cos)\s*\(([^)]+)\)')

def _omega_from_term(node):
    """从单项 AST (形式 k*x 或 x) 提取 k. 不匹配返 None."""
    if isinstance(node, ast.Name):
        return 1
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mult):
        if (isinstance(node.left, ast.Constant)
                and isinstance(node.left.value, (int, float))
                and isinstance(node.right, ast.Name)):
            return node.left.value
        if (isinstance(node.right, ast.Constant)
                and isinstance(node.right.value, (int, float))
                and isinstance(node.left, ast.Name)):
            return node.right.value
    return None

def _expr_has_var(node):
    """判断 AST 中是否含任何 Name (变量). 用于检查 k*x + c 中 c 是否为常数."""
    if isinstance(node, ast.Name):
        return True
    if isinstance(node, ast.BinOp):
        return _expr_has_var(node.left) or _expr_has_var(node.right)
    if isinstance(node, ast.UnaryOp):
        return _expr_has_var(node.operand)
    if isinstance(node, ast.Call):
        return any(_expr_has_var(a) for a in node.args)
    return False

def _extract_omega(body):
    """从 body 中找第一个 sin(...)/cos(...), 解析参数 k*x+c, 返回 k 作为 omega.
    非线性参数 (如 x^2, sin(x)*x) 返 None, 调用方回退普通 quad."""
    m = _OMEGA_ARG_RE.search(body)
    if not m:
        return None
    arg = m.group(2).strip()
    try:
        node = ast.parse(arg, mode="eval").body
    except SyntaxError:
        return None
    # 形式 1: k*x 或 x
    w = _omega_from_term(node)
    if w is not None:
        return w
    # 形式 2: k*x + c (c 常数, 不依赖变量)
    if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub)):
        w = _omega_from_term(node.left)
        if w is not None and not _expr_has_var(node.right):
            return w
        w = _omega_from_term(node.right)
        if w is not None and not _expr_has_var(node.left):
            return w
    return None

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
    # r14: 移除 ast.Num 兼容分支.  Python 3.8+ 所有 numeric literals 都是 ast.Constant
    #   (ast.Num 是 deprecated alias, isinstance 检查会触发 deprecation warning,
    #    嵌套 sum 极限时 9 次/iter × 数万次 iter = 卡 15s).  现代 Python 走上面 ast.Constant 分支.
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
        # ★ 高阶函数: sum/product/integrate 需要保留 body 字符串 (不预先 evaluate)
        if fname == "sum" or fname == "product":
            if len(node.args) != 4:
                raise ValueError("%s() requires (var, lo, hi, body)" % fname)
            # 第一个参数是变量名, 可以是 ast.Name (k) 或 ast.Constant ('k')
            a0 = node.args[0]
            if isinstance(a0, ast.Name):
                var_name = a0.id
            elif isinstance(a0, ast.Constant) and isinstance(a0.value, str):
                var_name = a0.value
            else:
                raise ValueError("%s() first arg must be a variable name" % fname)
            lo = _eval(node.args[1], env)
            hi = _eval(node.args[2], env)
            # r14: 直接传 body AST node, 跳过 ast.unparse + 重 parse 的开销
            #   (嵌套 sum 极限时 _py_sum 每次被调都 unparse+parse 一遍, 50+ f calls × 200
            #    内部 iter = 10000 次 unparse/parse 卡 15s)
            if fname == "sum":
                return _py_sum(var_name, lo, hi, node.args[3], env)
            return _py_product(var_name, lo, hi, node.args[3], env)
        if fname == "integrate":
            if len(node.args) != 4:
                raise ValueError("integrate() requires (f, x, a, b)")
            a1 = node.args[1]
            if isinstance(a1, ast.Name):
                var_name = a1.id
            elif isinstance(a1, ast.Constant) and isinstance(a1.value, str):
                var_name = a1.value
            else:
                raise ValueError("integrate() second arg must be a variable name")
            f_str = ast.unparse(node.args[0])
            a = _eval(node.args[2], env)
            b = _eval(node.args[3], env)
            return _py_integrate(f_str, var_name, a, b, env)
        # ★ 嵌套 limit(body, var, point) - 委托给 compute_limit
        if fname == "limit":
            if len(node.args) != 3:
                raise ValueError("limit() requires (expr, var, point)")
            a0 = node.args[1]
            if isinstance(a0, ast.Name):
                var_name = a0.id
            elif isinstance(a0, ast.Constant) and isinstance(a0.value, str):
                var_name = a0.value
            else:
                raise ValueError("limit() second arg must be a variable name")
            body_str = ast.unparse(node.args[0])
            point_str = ast.unparse(node.args[2])
            return compute_limit(body_str, var_name, point_str, mp.dps)
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


# r15: 把 n!! / (expr)!! 翻译为 double_fact(n) / double_fact((expr)).
#   双阶乘在数学中是后缀算子, 应用到紧邻的"原子" (数字/标识符/平衡括号组).
#   例: ((2*10)!!/(2*10-1)!!)**2 → ((double_fact((2*10))/double_fact((2*10-1)))**2
_DOUBLE_BANG_TOKEN_RE = re.compile(r"!!")
def _doublebang_to_doublefact(src):
    """从 src 中找 !!, 向前回溯到原子边界 (数字/标识符/平衡括号) 起点, 替换为 double_fact(ATOM).
    r15-amend9 (Bug 6.1): 重写为循环 — 每次找第一个 !! 在当前 result 上回溯原子并替换,
      然后重新扫描. 旧版在原始 src 上回溯, 不递归处理已替换的内部 !!, 对 (n!!)!! 输出
      非法 Python 语法 (含未替换 !! + 未闭合括号). 新版保证嵌套 !! 正确转换."""
    result = src
    guard = 0
    while guard < 200:
        idx = result.find('!!')
        if idx < 0:
            break
        j = idx - 1
        if j < 0:
            # !! 在串首, 无法形成原子, 跳过这两个字符避免死循环
            result = result[:idx] + result[idx + 2:]
            guard += 1
            continue
        c = result[j]
        if c == ')':
            # 平衡括号: 找匹配的 (
            depth = 1
            k = j - 1
            while k >= 0 and depth > 0:
                if result[k] == ')':
                    depth += 1
                elif result[k] == '(':
                    depth -= 1
                k -= 1
            # k 指向 ( 的前一个字符, 原子起点 = k+1
            atom_start = k + 1
        else:
            # NAME 或 NUMBER: 回溯到非标识符字符
            k = j
            while k >= 0 and (result[k].isalnum() or result[k] == '_' or result[k] == '.'):
                k -= 1
            atom_start = k + 1
        atom = result[atom_start:idx]
        if not atom:
            # 没找到原子, 跳过这两个字符避免死循环
            result = result[:idx] + result[idx + 2:]
            guard += 1
            continue
        # r15-amend9: 去除原子外层多余括号, 避免 double_fact((expr)) 丑格式.
        #   仅当首尾是匹配的 ( ) 时剥离 (e.g. (2*10) -> 2*10, (double_fact(n)) -> double_fact(n)).
        #   (a)+(b) 不剥离 (首 ( 不匹配尾 )).
        if len(atom) >= 2 and atom[0] == '(' and atom[-1] == ')':
            d = 0
            outer_matched = True
            for ci, ch in enumerate(atom):
                if ch == '(':
                    d += 1
                elif ch == ')':
                    d -= 1
                    if d == 0 and ci < len(atom) - 1:
                        outer_matched = False
                        break
            if outer_matched:
                atom = atom[1:-1]
        result = (result[:atom_start] + 'double_fact(' + atom + ')'
                  + result[idx + 2:])
        guard += 1
    return result


# r15-amend10 (Bug 29): 把 n! / (expr)! 翻译为 factorial(n) / factorial((expr)).
#   单阶乘后缀算子, 应用到紧邻的"原子" (数字/标识符/平衡括号组).
#   必须在 _doublebang_to_doublefact 之后调用 (先处理 !!, 再处理剩余的单 !).
#   例:  n! -> factorial(n);  (2*n+1)! -> factorial((2*n+1));  5! -> factorial(5)
def _singlebang_to_factorial(src):
    """从 src 中找单 ! (非 !!), 向前回溯到原子边界 (数字/标识符/平衡括号) 起点,
    替换为 factorial(ATOM).  与 JS 端 _toPythonBody 逻辑一致, 供 Python 直接
    接收含 ! 的 body 时 (如 /nsum 端点直接 curl) 也能正确解析."""
    result = src
    scan_from = 0
    guard = 0
    while guard < 200:
        # 找第一个单 ! (非 !!, 非 !=)
        idx = -1
        i = scan_from
        while i < len(result):
            if (result[i] == '!' and (i + 1 >= len(result) or result[i + 1] != '!')
                    and (i + 1 >= len(result) or result[i + 1] != '=')):
                idx = i
                break
            i += 1
        if idx < 0:
            break  # 没有单 ! 了
        # 向前回溯找原子起点 (跳过空白)
        j = idx - 1
        while j >= 0 and result[j] in (' ', '\t'):
            j -= 1
        atom_start = -1
        atom = ''
        if j >= 0:
            c = result[j]
            if c == ')':
                # 平衡括号: 找匹配的 (
                depth = 1
                k = j - 1
                while k >= 0 and depth > 0:
                    if result[k] == ')':
                        depth += 1
                    elif result[k] == '(':
                        depth -= 1
                    k -= 1
                atom_start = k + 1
                atom = result[atom_start:j + 1]
            elif c.isalnum() or c == '_' or c == '.':
                # NAME 或 NUMBER: 回溯到非标识符字符
                k = j
                while k >= 0 and (result[k].isalnum() or result[k] == '_' or result[k] == '.'):
                    k -= 1
                atom_start = k + 1
                atom = result[atom_start:j + 1]
        if atom_start < 0 or not atom:
            # ! 之前不是原子 (运算符等), 跳过此 ! 避免死循环
            scan_from = idx + 1
            guard += 1
            continue
        result = (result[:atom_start] + 'factorial(' + atom + ')'
                  + result[idx + 1:])
        scan_from = 0  # 替换后字符串变化, 从头重扫
        guard += 1
    return result


# 数字字面量 (整数/小数/科学计数法) 的精确正则.
#   不能用 ast.parse 后再改 value, 因为 1e114514 已经被 Python 转成 inf(float).
#   必须在 ast.parse 之前, 把数字字面量包成 __mpf__("...") 函数调用,
#   这样 _eval 看到的是字符串 '1e114514', mpf('1e114514') 是任意精度的 mpf.
#   ★ 注意: 捕获组必须包含整个数字字面量 (含可选科学计数法), 否则
#     sub 替换时 \1 会漏掉 e114514 部分, 1e114514 被切成 1 + e114514.
_NUMBER_RE = re.compile(
    r"(?<![\w\.'])"                           # 前面不是 word char / . / '  (防止包到字符串字面量内的数字)
    r"((?:\d+\.?\d*|\.\d+)"                   # 整数/小数 (不带前导符号, 符号归一元运算符)
    r"(?:[eE][+\-]?\d+)?)"                    # 可选科学计数法 (含在捕获组内, 指数符号保留)
    r"(?![\w\.'])"                            # 后面不是 word char / . / '
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
    with mp.workdps(precision):
        expr = _wrap_numbers_as_mpf(expr)   # ★ 先包数字字面量, 防 1e114514 变 inf
        expr = _insert_implicit_mul(expr)  # 隐式乘法 2x / (a)(b)
        expr = _caret_to_pow(expr)         # 前端 ^  =>  Python **
        expr = _doublebang_to_doublefact(expr)  # r15: n!! => double_fact(n)
        expr = _singlebang_to_factorial(expr)  # r15-amend10 (Bug 29): n! => factorial(n)
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
    with mp.workdps(precision):
        expr = _to_equation_ast(expr)
        expr = _insert_implicit_mul(expr)  # 隐式乘法
        expr = _caret_to_pow(expr)         # 前端 ^  =>  Python **
        expr = _doublebang_to_doublefact(expr)  # r15: n!! => double_fact(n)
        expr = _singlebang_to_factorial(expr)  # r15-amend10 (Bug 29): n! => factorial(n)
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
def compute_limit(expr, variable, point, precision, *, direction=0):
    """数值极限: 用 mpmath.limit 走任意精度 Richardson/Shanks 加速

    expr:    字符串,  例 "(1 + 1/x)^x"  或  "(2x + exp(4*x))^(1/x)"
             也接受已经 __mpf__ 包装过的字符串 (从 _eval 递归调用时)
    variable: 字符串, 例 "x"
    point:   字符串/数值/已包装 __mpf__ 字符串, 接受 "0"  "1.5"  "inf"  "-inf"  "nan"
    precision: 整数 dps
    direction: 可选, -1 / 0 / +1 (默认 0 = 双侧). +1 = 从右侧趋近, -1 = 从左侧趋近.
             0/1/-1 以外值抛 ValueError (由 /limit 端点转 HTTP 400).
    """
    if direction not in (-1, 0, 1):
        raise ValueError("direction must be -1, 0, or +1 (got %r)" % (direction,))
    if not HAS_MPMATH:
        raise RuntimeError("mpmath is not installed. Run: pip install mpmath")
    setup_mpmath(precision)
    with mp.workdps(precision):
        expr = _wrap_numbers_as_mpf(expr)   # ★ 防 1e114514 变 inf
        expr = _insert_implicit_mul(expr)  # 隐式乘法
        expr = _caret_to_pow(expr)         # 前端 ^  =>  Python **
        expr = _doublebang_to_doublefact(expr)  # r15: n!! => double_fact(n)
        expr = _singlebang_to_factorial(expr)  # r15-amend10 (Bug 29): n! => factorial(n)
        tree = ast.parse(expr, mode="eval")
        env = dict(_MP_CONSTANTS)

        def f(x):
            env[variable] = x
            return _eval(tree.body, env)

        # 把 point 解释为 mpf (支持 inf/-inf/nan)
        #   如果 point 已经是 __mpf__('xxx') 包装 (来自 _eval 嵌套调用), 先 evaluate
        pt_str = point
        if isinstance(pt_str, str) and pt_str.startswith("__mpf__("):
            # 通过 _eval 求值得到 mpf
            try:
                pt_tree = ast.parse(pt_str, mode="eval")
                pt = _eval(pt_tree.body, env)
            except Exception:
                pt = mpf('0')   # fallback
        else:
            pt = mpf(point)
        # r13: 发散检测前移到 mpmath.limit 之前.
        #   原因: mpmath.limit 默认 exp=False 线性采样对 0/0 类极限 (代数收敛) 收敛极慢,
        #   而 exp=True 指数采样 (h=2^-k) 又对发散极限 (e.g. 1/x at 0+) 不友好:
        #   exp=True 让 1/x 序列在 h=2^-k 时 f(2^-k) = 2^k 单调上升, 但 Richardson 仍可能
        #   误收敛到 0 或有限值 (尤其是 50 位精度下).  所以发散检测先跑, 命中 ±∞ 直接返回.
        #
        #   复数情况 (e.g. x^x at 0-) 不判发散, 走 mpmath 估计.
        #   pt 是 inf/-inf 时跳过 (1^∞ 类, e.g. (1+1/x)^x, 序列会从 inf 趋近 e, 误判为发散).
        def _detect_divergence(side):
            # pt 是 inf/-inf: 跳过 (会误判 1^∞ 极限为发散)
            if not isfinite(pt): return None
            # side: +1 (右) / -1 (左). 取 h=2^-10..2^-30 (21 个点)
            # r15-amend9 (Bug 2.2): 扩大 n 范围 10..30, 让 1/sqrt(x) 类亚线性发散
            #   (v=2^(n/2), n=19 时 v≈724 < 1e3) 在 n=30 时 v=32768 > 1e3 命中阈值.
            seq = []
            for n in range(10, 31):
                try:
                    h = mpf(2) ** (-n)
                    v = f(pt + side * h)
                    if not isfinite(v):
                        # 序列中某个点就是 inf/-inf/nan, 立即判 ±∞ (按方向 + sign(v))
                        if hasattr(v, 'real') and v.real != 0:
                            return mpf('inf') if v.real > 0 else mpf('-inf')
                        if v == inf or v > 0: return mpf('inf')
                        if v == -inf or v < 0: return mpf('-inf')
                        return None
                    # 复数: 不参与发散检测
                    if hasattr(v, 'real') and hasattr(v, 'imag') and v.imag != 0:
                        return None
                    seq.append(v)
                except Exception:
                    return None
            if len(seq) < 5: return None
            # 检查严格单调 + 同号
            growing = True
            all_pos = True
            all_neg = True
            for i in range(len(seq) - 1):
                if abs(seq[i+1]) <= 1.2 * abs(seq[i]): growing = False
                if seq[i] < 0 or seq[i+1] < 0: all_pos = False
                if seq[i] > 0 or seq[i+1] > 0: all_neg = False
            maxAbs = max(abs(v) for v in seq)
            if not growing:
                # r15-amend9 (Bug 2.3): 次级判据 — ln(x) at 0+ 类缓慢发散.
                #   相邻比 < 1.2 (ln 序列比 = (n+1)/n ≈ 1.1), 但绝对值持续增长.
                #   spec factor=10 对 n=10..30 的 ln(x) (ratio=3) 不够, 用 factor=2.
                #   条件: |v_last| > 2*|v_first| 且 maxAbs > 10 且绝对单调.
                if len(seq) >= 2:
                    abs_growing = all(abs(seq[i+1]) >= abs(seq[i])
                                      for i in range(len(seq) - 1))
                    if (abs_growing and abs(seq[-1]) > 2 * abs(seq[0])
                            and maxAbs > 10):
                        if all_pos: return mpf('inf')
                        if all_neg: return mpf('-inf')
                return None
            if maxAbs < 1e3: return None
            if all_pos: return mpf('inf')
            if all_neg: return mpf('-inf')
            return None

        # r13: 发散检测先跑. 命中 ±∞ 直接返回, 不进 mpmath.limit.
        if direction == 1:
            div = _detect_divergence(1)
            if div is not None: return div
        elif direction == -1:
            div = _detect_divergence(-1)
            if div is not None: return div
        elif direction == 0:
            # 双侧: 一侧发散同号才返回 ±∞
            divL = _detect_divergence(-1)
            divR = _detect_divergence(1)
            if divL is not None and divR is not None and divL == divR: return divL
            # 一侧发散一侧不发散: 仍走 mpmath 估计 (数学上 DNE, 不强行给 ±∞)

        # r13: mpmath.limit 默认 exp=True 指数采样, 让 0/0 类代数收敛极限 (e.g. x^x, x*ln(x) at 0)
        #      一次外推就到 50 位精度.  失败 (NoConvergence 等) 时回退到 exp=False 线性采样.
        #
        # r14 修正: pt 是 inf/-inf 时强制 exp=False.  mpmath.limit 在 isinf 分支 base 是
        #   g_base(k) = f((k+1)·sign(x)) (线性), 但 exp=True 会再套一层 g(k) = g_base(2^k) = f(2^k+1)
        #   (看 extrapolation.py line 2103-2105).  这对嵌套 sum/product 是致命的:
        #   f(n) 自身是 O(n) 求和, 在 50 位精度 adaptive_extrapolation 需要 k ≈ 40, 此时
        #   f(2^40) 调 2^40 ≈ 1e12 次 sum 迭代, 永远 hang (不会 throw, 永远不会 fallback).
        #   1^∞ 极限 (e.g. (1+1/x)^x at inf) 的 f 是 O(1) per call, exp=True 在 inf 也无害,
        #   但线性采样同样给正确结果, 不需要冒险.  0/0 类 (e.g. x^x at 0+) exp=True 收益
        #   仍保留, 因为 pt 是有限点.
        exp_flag = True if isfinite(pt) else False
        if direction == 0:
            try:
                result = limit(f, pt, exp=exp_flag)
            except (NoConvergence, ValueError, ZeroDivisionError):
                result = limit(f, pt, exp=False)   # fallback
        else:
            try:
                result = limit(f, pt, direction=direction, exp=exp_flag)
            except (NoConvergence, ValueError, ZeroDivisionError):
                result = limit(f, pt, direction=direction, exp=False)   # fallback

        return result

    # ---------- 数值无穷级数和 ----------
    # ★ r15-amend6: 发散预检测. mpmath.nsum 对发散级数静默返部分和 (maxterms 项累加),
    #   不抛异常. 用项趋于 0 测试做预检测: 抽样 3 个点 (i=start+100, +1000, +10000) 算 |f(i)|,
    #   若都 > 0.5 且不下降, 视为发散, 抛 ValueError. 让 bot 端 catch 后能显示 "nsum 失败: ... 发散"
    #   而不是错误地返 550.0 / 150.0 等部分和.
def _nsum_check_divergence(f, start_i, env, variable, sample_offsets=(100, 1000, 10000), threshold=mpf('0.5')):
    """抽样检测级数项 |f(i)| 是否随 i -> inf 趋于 0. 若不趋于 0, 抛 ValueError.
    threshold: 项绝对值下限, 若所有抽样点都 > threshold, 视为发散.

    检测范围 (r15-amend6):
      - f(i) = 1, 2, ... (常数): caught (项不趋于 0)
      - f(i) = i, i^2, ... (多项式): caught (项增长)
      - f(i) = (-1)^i, sin(i), ... (有界不收敛): caught (项不趋于 0)
    已知未覆盖 (留待 r15-amend7+):
      - f(i) = 1/i, 1/sqrt(i) (harmonic 类, 项趋于 0 但 ∑ 发散) -> 仍返部分和
    """
    samples = []
    for off in sample_offsets:
        try:
            env[variable] = start_i + off
            val = abs(f(start_i + off))
        except Exception:
            # 抽样点求值失败 (例如 1/0), 不据此判发散, 让 nsum 自己去处理
            return
        samples.append(val)
    # 全 > 阈值 -> 项不趋于 0 -> 发散
    if all(s > threshold for s in samples):
        raise ValueError(
            "nsum divergent series: term |f(i)| does not tend to 0 "
            "(sampled |f(%d)|=%g, |f(%d)|=%g, |f(%d)|=%g, all > %s)"
            % (start_i + sample_offsets[0], float(samples[0]),
               start_i + sample_offsets[1], float(samples[1]),
               start_i + sample_offsets[2], float(samples[2]),
               float(threshold))
        )

def compute_nsum(expr, variable, start, precision):
    """数值无穷级数: 用 mpmath.nsum 从 start 到 inf 求和.

    expr:     字符串, 例 "(2/3)^k"  或  "1/k^2"
    variable: 字符串, 例 "k"
    start:    数字, 整数 (求和起点)
    precision: 整数 dps

    返回: mpmath mpf 数值
    抛出: ValueError 当级数发散 (r15-amend6) 或 mpmath.nsum 内部错误
    """
    if not HAS_MPMATH:
        raise RuntimeError("mpmath is not installed. Run: pip install mpmath")
    setup_mpmath(precision)
    with mp.workdps(precision):
        expr = _wrap_numbers_as_mpf(expr)   # 防 1e114514 变 inf
        expr = _insert_implicit_mul(expr)  # 隐式乘法
        expr = _caret_to_pow(expr)         # 前端 ^  =>  Python **
        expr = _doublebang_to_doublefact(expr)  # r15: n!! => double_fact(n)
        expr = _singlebang_to_factorial(expr)  # r15-amend10 (Bug 29): n! => factorial(n)
        tree = ast.parse(expr, mode="eval")
        env = dict(_MP_CONSTANTS)

        start_i = int(start)
        if start_i != start:
            raise ValueError("nsum start must be an integer (got %s)" % start)

        def f(x):
            env[variable] = x
            return _eval(tree.body, env)

        # ★ r15-amend6: 发散预检测 (项 |f(i)| -> 0 检测). mpmath.nsum 对发散级数静默返部分和,
        #   此预检测在 nsum 之前先抽样验证项是否趋于 0, 若不趋于 0 则抛 ValueError.
        #   注: 检查在 nsum 之前, 不要破坏 env 状态 (让后续 nsum 自己设 env[variable])
        _nsum_check_divergence(f, start_i, env, variable)

        # mpmath.nsum 接受字符串 method (例如 'richardson' 是默认),
        # 收敛时返回 mpf, 发散时抛异常
        return nsum(f, [start_i, inf])


    # r15-amend9 (Bug 5.2): 乘积收敛预检测. 仿 _nsum_check_divergence,
    #   检测 |f(i) - 1| 是否趋于 0. 收敛乘积要求 f(i) -> 1, 若 |f(i) - 1| 不趋于 0,
    #   乘积发散. 抛 ValueError 让 bot 端显示 "nprod 失败: ... 发散" 而非错误返部分积.
def _nprod_check_convergence(f, start_i, env, variable, sample_offsets=(100, 1000, 10000), threshold=mpf('0.5')):
    """抽样检测乘积项 |f(i) - 1| 是否随 i -> inf 趋于 0. 若不趋于 0, 抛 ValueError.
    threshold: |f(i) - 1| 下限, 若所有抽样点都 > threshold, 视为发散."""
    samples = []
    for off in sample_offsets:
        try:
            env[variable] = start_i + off
            val = abs(f(start_i + off) - 1)
        except Exception:
            # 抽样点求值失败, 不据此判发散, 让 nprod 自己去处理
            return
        samples.append(val)
    # 全 > 阈值 -> 项不趋于 1 -> 发散
    if all(s > threshold for s in samples):
        raise ValueError(
            "nprod divergent product: term |f(i) - 1| does not tend to 0 "
            "(sampled |f(%d) - 1|=%g, |f(%d) - 1|=%g, |f(%d) - 1|=%g, all > %s)"
            % (start_i + sample_offsets[0], float(samples[0]),
               start_i + sample_offsets[1], float(samples[1]),
               start_i + sample_offsets[2], float(samples[2]),
               float(threshold))
        )

def compute_nprod(expr, variable, start, precision):
    """数值无穷乘积: 用 mpmath.nprod 从 start 到 inf 求积.  r15: 加给 product 自由上界/inf 上界走.

    expr:     字符串, 例 "(n^3-1)/(n^3+1)"  或  "1 - 1/n^2"
    variable: 字符串, 例 "n"
    start:    数字, 整数 (乘积起点)
    precision: 整数 dps

    返回: mpmath mpf 数值
    """
    if not HAS_MPMATH:
        raise RuntimeError("mpmath is not installed. Run: pip install mpmath")
    setup_mpmath(precision)
    with mp.workdps(precision):
        expr = _wrap_numbers_as_mpf(expr)
        expr = _insert_implicit_mul(expr)
        expr = _caret_to_pow(expr)
        expr = _doublebang_to_doublefact(expr)
        expr = _singlebang_to_factorial(expr)  # r15-amend10 (Bug 29): n! => factorial(n)
        tree = ast.parse(expr, mode="eval")
        env = dict(_MP_CONSTANTS)

        start_i = int(start)
        if start_i != start:
            raise ValueError("nprod start must be an integer (got %s)" % start)

        def f(x):
            env[variable] = x
            return _eval(tree.body, env)

        # r15-amend9 (Bug 5.2): 收敛预检测 — 乘积项 |f(i) - 1| 应趋于 0.
        #   若不趋于 0, 乘积发散, 抛 ValueError 而非返部分积.
        _nprod_check_convergence(f, start_i, env, variable)

        return nprod(f, [start_i, inf])

def _format_mpc(value, imag_zero_tol=None):
    """格式化 mpmath mpc 为字符串.  虚部绝对值 < imag_zero_tol 时视为 0.

    imag_zero_tol 默认 mp.dps 位数下 1e-(dps-2) 级别, 即 < 1e-10 视为 0
    (避免 mpmath 数值精度噪声出现 "1.5 + 1e-126j").

    返回: 纯实数 -> "1.5",  复数 -> "(1.5 + 0.5j)" / "(1.5 - 0.5j)"
    """
    # mpc 检测: mpc 有 .real 和 .imag, mpf 没有 (只 mpf 只有 context).  也支持 Python built-in complex.
    is_mpc = (hasattr(value, "real") and hasattr(value, "imag")
              and not isinstance(value, (int, float)))
    if is_mpc:
        re = value.real
        im = value.imag
        if imag_zero_tol is None:
            if HAS_MPMATH:
                imag_zero_tol = mpf(10) ** (-(mp.dps - 2)) if mp.dps > 4 else mpf("1e-2")
            else:
                imag_zero_tol = 1e-10
        try:
            im_abs = abs(im)
        except Exception:
            im_abs = 0
        if im_abs < imag_zero_tol:
            return str(re)
        sign = "+" if im >= 0 else "-"
        return "(" + str(re) + " " + sign + " " + str(abs(im)) + "j)"
    return str(value)


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
                precision = int(data.get("precision", DEFAULT_PRECISION))
                result = evaluate_expression(
                    data.get("expression", ""),
                    data.get("variables") or {},
                    precision,
                )
                # ★ r15-amend10: _format_mpc 必须在 workdps 上下文内调用,
                #   否则 str(mpf) 用默认 mp.dps=15 而非请求的 precision
                with mp.workdps(precision):
                    self._send_json({"result": _format_mpc(result)})

            elif path == "/solve":
                opts = data.get("options", {})
                precision = int(opts.get("precision", DEFAULT_PRECISION))
                roots = solve_equation(
                    data.get("expression", ""),
                    data.get("variable", "x"),
                    float(opts.get("start", -100)),
                    float(opts.get("end",   100)),
                    int(opts.get("samples", 500)),
                    str(opts.get("epsilon", "1e-30")),
                    precision,
                    variables=opts.get("variables") or {}
                )
                with mp.workdps(precision):
                    self._send_json({"result": [_format_mpc(r) for r in roots]})

            elif path == "/limit":
                # r12: 解析可选 direction 字段 (-1, 0, +1), 默认 0 (双侧, 兼容 r3-r11)
                dir_raw = data.get("direction", 0)
                try:
                    direction = int(dir_raw)
                except (TypeError, ValueError):
                    self._send_json({
                        "error": "direction must be -1, 0, or +1 (got %r)" % (dir_raw,)
                    }, 400)
                    return
                if direction not in (-1, 0, 1):
                    self._send_json({
                        "error": "direction must be -1, 0, or +1 (got %r)" % (direction,)
                    }, 400)
                    return
                precision = int(data.get("precision", DEFAULT_PRECISION))
                result = compute_limit(
                    data.get("expression", ""),
                    data.get("variable", "x"),
                    str(data.get("point", "0")),
                    precision,
                    direction=direction
                )
                with mp.workdps(precision):
                    self._send_json({"result": _format_mpc(result), "direction": direction})

            elif path == "/nsum":
                precision = int(data.get("precision", DEFAULT_PRECISION))
                result = compute_nsum(
                    data.get("expression", ""),
                    data.get("variable", "k"),
                    float(data.get("start", 0)),
                    precision
                )
                with mp.workdps(precision):
                    self._send_json({"result": _format_mpc(result)})

            elif path == "/nprod":  # r15: 无穷乘积
                precision = int(data.get("precision", DEFAULT_PRECISION))
                result = compute_nprod(
                    data.get("expression", ""),
                    data.get("variable", "n"),
                    float(data.get("start", 1)),
                    precision
                )
                with mp.workdps(precision):
                    self._send_json({"result": _format_mpc(result)})

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

    # ★ 允许端口复用, 避免 Windows TIME_WAIT 状态导致 bind 失败
    # ★ 用 ThreadingMixIn 让多请求并发处理, 避免前一个慢请求阻塞后一个
    from socketserver import ThreadingMixIn
    class ReuseTCPServer(ThreadingMixIn, HTTPServer):
        allow_reuse_address = True
        daemon_threads = True
    server = ReuseTCPServer((host, port), Handler)
    print("Precision math server listening on http://%s:%d" % (host, port))
    print("  GET  /health")
    print("  POST /evaluate  {expression, variables, precision}")
    print("  POST /solve     {expression, variable, options}")
    print("  POST /limit     {expression, variable, point, precision}")
    print("  POST /nsum      {expression, variable, start, precision}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.shutdown()

if __name__ == "__main__":
    main()
