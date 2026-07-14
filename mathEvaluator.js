/**
 * mathEvaluator.js
 * -----------------------------------------------------------------------------
 * 通用数学公式求值 & 方程求解器
 *  - 支持 一次 / 二次 / 多次 / 超越 方程
 *  - 支持 sin / cos / tan / log / exp / sqrt 等函数及任意复合形式
 *  - 默认精度为 JS Number (~15~17 位有效数字)
 *  - 可选 Python 后端 (基于 mpmath) 实现任意精度 (默认 50 位)
 *  - 异步接口内置 10s 超时 (可配), 同步接口采用协作式超时
 *  - 单文件,UMD 风格,既可 <script> 引入也可 Node require
 *  - 可在外部通过 MathEvaluator.registerFunction() 扩展函数
 *
 * 导出 API
 *   MathEvaluator.evaluate(expr, vars?)               -> number
 *   MathEvaluator.evaluateAsync(expr, vars?, opts?)  -> Promise<number|string>
 *   MathEvaluator.solve(expr, varName, opts?)        -> number[]
 *   MathEvaluator.solveAsync(expr, varName, opts?)   -> Promise<number[]>
 *   MathEvaluator.registerFunction(name, fn, arity?) -> void
 *   MathEvaluator.setConfig({...})                   -> void
 *   -- Python 后端生命周期 (Node) --
 *   MathEvaluator.startPythonBackend(opts?)          -> Promise<{url,port,proc,stop}>
 *   MathEvaluator.stopPythonBackend()                -> Promise<void>
 *   MathEvaluator.isPythonBackendRunning()           -> boolean
 *   -- 自动启动 (任一 *Async 传 { autoStartPython: true }) --
 *
 * 表达式语法
 *   数字      123  3.14  1.5e-3  .5
 *   标识符    x  y  pi  e  tau  phi
 *   运算符    +  -  *  /  %  ^  !   (^ 为乘方, 优先级同 **)
 *   函数      sin  cos  tan  asin  acos  atan  atan2
 *             sinh cosh tanh
 *             log(=log10)  ln  log2  exp  sqrt  cbrt
 *             abs  floor  ceil  round  trunc  sign
 *             min  max  pow  fact
 *   分组      (  )   ,   (函数参数分隔)
 *   隐式乘    2x  3(x+1)  (a)(b)        可选, 开启需 setConfig({implicitMul:true})
 * -----------------------------------------------------------------------------
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MathEvaluator = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ============================================================
   * 全局配置
   * ============================================================ */
  const config = {
    timeout: 10000,          // 默认 10s 超时
    pythonUrl: null,         // 设置后会调用 Python 高精度后端
    defaultPrecision: 50,    // Python 后端默认有效位数
    epsilon: 1e-12,          // 求解收敛阈值
    maxIter: 200,            // 单根最大迭代次数
    sampleDomain: [-1000, 1000], // 求解时默认搜索区间
    sampleCount: 5000,       // 求解时默认采样数
    implicitMul: true        // 是否启用隐式乘法 2x / 3(x+1) (默认开启, 符合数学惯例)
  };

  function setConfig(opts) {
    if (opts) Object.assign(config, opts);
  }

  /* ============================================================
   * 词法分析 (Tokenizer)
   * ============================================================ */
  function tokenize(input) {
    if (typeof input !== 'string') {
      throw new TypeError('Expression must be a string');
    }
    const tokens = [];
    const len = input.length;
    let i = 0;

    while (i < len) {
      const c = input[i];

      // 空白
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }

      // 数字 (含科学计数法)
      if ((c >= '0' && c <= '9') || c === '.') {
        let j = i;
        let hasDot = c === '.';
        let hasE = false;
        while (j < len) {
          const ch = input[j];
          if (ch >= '0' && ch <= '9') { j++; }
          else if (ch === '.' && !hasDot && !hasE) { hasDot = true; j++; }
          else if ((ch === 'e' || ch === 'E') && !hasE && j > i) {
            hasE = true; j++;
            if (input[j] === '+' || input[j] === '-') j++;
          }
          else break;
        }
        const numStr = input.substring(i, j);
        const num = parseFloat(numStr);
        if (Number.isNaN(num)) throw new Error('Invalid number: ' + numStr);
        // 小数位数太多 / 极大极小数: parseFloat 会下溢或上溢, 但我们要保留原始字符串
        //   例: "0." + 1000 个 "0" + "1"  ->  parseFloat = 0 (下溢), 原始串是 1e-1001
        //   解析原始字符串成 "1e-1001" 这种形式挂在 number._origStr 上
        const token = { type: 'num', value: num };
        if (num === 0 || !isFinite(num)) {
          // 小数情况: 0.<若干0><数字>   ->   <第一个非零数字>.<其余>e-<前导0个数+1>
          const m = numStr.match(/^0\.(0*)([1-9]\d*)$/);
          if (m) {
            const leadingZeros = m[1].length;
            const digits = m[2];
            const exp = -(leadingZeros + 1);
            const mantissa = digits[0] + (digits.length > 1 ? '.' + digits.slice(1) : '');
            token._origStr = mantissa + 'e' + exp;
            // 例: 0.00123  ->  leadingZeros=1, digits="123", mantissa="1.23", exp=-2  ->  "1.23e-2"  ✓
            // 例: 0.1     ->  leadingZeros=0, digits="1", mantissa="1", exp=-1     ->  "1e-1"  ✓
            // 例: 0.0001  ->  leadingZeros=3, digits="1", mantissa="1", exp=-4     ->  "1e-4"  ✓
          } else if (/^\d+$/.test(numStr) && numStr.length > 20) {
            // 大整数 (20+ 位的整数字面量), 走 BigInt 路径
            token.value = BigInt(numStr);
          } else if (num === Infinity || num === -Infinity) {
            // 上溢: 保留原串
            token._origStr = numStr;
          }
        }
        tokens.push(token);
        i = j;
        continue;
      }

      // 标识符 (变量 / 常量 / 函数名)
      if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_') {
        let j = i;
        while (j < len) {
          const ch = input[j];
          if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
              (ch >= '0' && ch <= '9') || ch === '_') j++;
          else break;
        }
        tokens.push({ type: 'ident', value: input.substring(i, j) });
        i = j;
        continue;
      }

      // Python 风格 ** 视作 ^ (必须在单字符 * 之前, 否则会被先吞掉)
      if (c === '*' && input[i + 1] === '*') {
        tokens.push({ type: 'op', value: '^' });
        i += 2; continue;
      }

      // 运算符 / 分组
      if (c === '+' || c === '-' || c === '*' || c === '/' || c === '^' || c === '%') {
        tokens.push({ type: 'op', value: c });
        i++; continue;
      }
      if (c === '!') { tokens.push({ type: 'op', value: '!' }); i++; continue; }
      if (c === '(') { tokens.push({ type: 'lp' }); i++; continue; }
      if (c === ')') { tokens.push({ type: 'rp' }); i++; continue; }
      if (c === ',') { tokens.push({ type: 'comma' }); i++; continue; }

      throw new Error("Unexpected character '" + c + "' at position " + i);
    }
    tokens.push({ type: 'eof' });
    return tokens;
  }

  // 隐式乘法: 在 token 流中识别 2x / 3(x / )(a) 等情形, 插入 *
  // 区分:  sin(x) 是函数调用 (不插 *),  x(y) 是隐式乘法 (插 *)
  // 依据:  ident 后面跟 ( 时, 只有当 ident 是已注册函数才视为函数调用
  function insertImplicitMul(tokens) {
    const out = [];
    const isValue = (t) => t.type === 'num' ||
      (t.type === 'ident' && t.value !== undefined && t.type !== 'lp') ||
      t.type === 'rp';
    const isStartOfValue = (t) => t.type === 'num' || t.type === 'ident' || t.type === 'lp';
    const isKnownFunc = (name) => Object.prototype.hasOwnProperty.call(FUNCTIONS, name)
      // 高阶函数在 evaluateAst 里直接 dispatch, 不在 FUNCTIONS 表, 这里也加进白名单
      || name === 'sum' || name === 'product' || name === 'diff'
      || name === 'integrate' || name === 'limit';
    for (let i = 0; i < tokens.length; i++) {
      const cur = tokens[i];
      const next = tokens[i + 1];
      out.push(cur);
      if (!next) break;
      // 数字/右括号/标识符  紧跟  标识符/左括号   ->  隐式 *
      const valueAfterValue = isValue(cur) && isStartOfValue(next);
      if (valueAfterValue) {
        // 只对"已知函数名 + (" 保留函数调用语义, 其余 ident+( 视为隐式乘
        const isFuncCall = cur.type === 'ident' && next.type === 'lp' && isKnownFunc(cur.value);
        if (!isFuncCall) {
          out.push({ type: 'op', value: '*' });
        }
      }
    }
    return out;
  }

  /* ============================================================
   * 语法分析 (Recursive Descent Parser)
   *
   * 优先级 (从低到高)
   *   expr   = term  (('+' | '-') term)*
   *   term   = unary (('*' | '/' | '%') unary)*
   *   unary  = ('+' | '-' | '!') unary | power
   *   power  = primary ('^' unary)?           右结合
   *   primary= number | ident ('(' args ')')? | '(' expr ')'
   * ============================================================ */
  function parse(input, opts) {
    opts = opts || {};
    let tokens = tokenize(input);
    if (config.implicitMul || opts.implicitMul) {
      tokens = insertImplicitMul(tokens);
    }
    let pos = 0;
    const peek = () => tokens[pos];
    const consume = () => tokens[pos++];
    const accept = (type, value) => {
      const t = peek();
      if (t.type === type && (value === undefined || t.value === value)) return consume();
      return null;
    };

    function parseExpr() {
      let left = parseTerm();
      while (peek().type === 'op' && (peek().value === '+' || peek().value === '-')) {
        const op = consume().value;
        const right = parseTerm();
        left = { type: 'binop', op, left, right };
      }
      return left;
    }
    function parseTerm() {
      let left = parseUnary();
      while (peek().type === 'op' &&
             (peek().value === '*' || peek().value === '/' || peek().value === '%')) {
        const op = consume().value;
        const right = parseUnary();
        left = { type: 'binop', op, left, right };
      }
      return left;
    }
    function parseUnary() {
      if (peek().type === 'op' &&
          (peek().value === '+' || peek().value === '-' || peek().value === '!')) {
        const op = consume().value;
        return { type: 'unary', op, operand: parseUnary() };
      }
      return parsePower();
    }
    function parsePower() {
      const base = parsePrimary();
      if (peek().type === 'op' && peek().value === '^') {
        consume();
        const exp = parseUnary(); // 右结合
        return { type: 'binop', op: '^', left: base, right: exp };
      }
      return base;
    }
    function parsePrimary() {
      const t = peek();
      let node;
      if (t.type === 'num') {
        consume();
        node = { type: 'num', value: t.value };
        if (t._origStr) node._origStr = t._origStr;  // 极小/极大字面量, 保留原始字符串
      }
      else if (t.type === 'lp') {
        consume();
        const e = parseExpr();
        if (!accept('rp')) throw new Error("Expected ')'");
        node = e;
      }
      else if (t.type === 'ident') {
        consume();
        if (accept('lp')) {
          const args = [];
          if (peek().type !== 'rp') {
            args.push(parseExpr());
            while (accept('comma')) args.push(parseExpr());
          }
          if (!accept('rp')) throw new Error("Expected ')' after function arguments");
          node = { type: 'func', name: t.value, args };
        } else {
          node = { type: 'var', name: t.value };
        }
      }
      else throw new Error('Unexpected token: ' + JSON.stringify(t));
      // 后缀阶乘  n!
      while (peek().type === 'op' && peek().value === '!') {
        consume();
        node = { type: 'unary', op: '!', operand: node };
      }
      return node;
    }

    const tree = parseExpr();
    if (peek().type !== 'eof') throw new Error('Unexpected trailing token: ' + JSON.stringify(peek()));
    return tree;
  }

  /* ============================================================
   * 复数类型: 遇到 sqrt(-1) / log(0) / asin(2) 等自动升级
   * ============================================================ */
  const Complex = (function () {
    function C(re, im) {
      this.re = re || 0;
      this.im = im || 0;
    }
    C.prototype.add = function (o) { return new C(this.re + o.re, this.im + o.im); };
    C.prototype.sub = function (o) { return new C(this.re - o.re, this.im - o.im); };
    C.prototype.mul = function (o) {
      return new C(this.re * o.re - this.im * o.im,
                    this.re * o.im + this.im * o.re);
    };
    C.prototype.div = function (o) {
      const d = o.re * o.re + o.im * o.im;
      if (d === 0) return new C(NaN, NaN);
      return new C((this.re * o.re + this.im * o.im) / d,
                   (this.im * o.re - this.re * o.im) / d);
    };
    C.prototype.neg = function () { return new C(-this.re, -this.im); };
    C.prototype.abs = function () { return Math.sqrt(this.re * this.re + this.im * this.im); };
    C.prototype.arg = function () { return Math.atan2(this.im, this.re); };
    C.prototype.sqrt = function () {
      const r = Math.sqrt(this.abs());
      const t = this.arg() / 2;
      return new C(r * Math.cos(t), r * Math.sin(t));
    };
    C.prototype.ln = function () {
      return new C(Math.log(this.abs()), this.arg());
    };
    C.prototype.exp = function () {
      const e = Math.exp(this.re);
      return new C(e * Math.cos(this.im), e * Math.sin(this.im));
    };
    C.prototype.pow = function (o) {
      // a^b = exp(b * ln(a))
      const lnA = this.ln();
      const reB = o.re || 0, imB = o.im || 0;
      const reX = reB * lnA.re - imB * lnA.im;
      const imX = reB * lnA.im + imB * lnA.re;
      return new C(reX, imX).exp();
    };
    // 取模 (|z|) 用于残差计算
    C.prototype.modulus = C.prototype.abs;
    C.prototype.toString = function () {
      let r = this.re, i = this.im;
      // 浮点误差清理: 极小值归 0
      if (Math.abs(r) < 1e-12) r = 0;
      if (Math.abs(i) < 1e-12) i = 0;
      if (i === 0) return formatReal(r);
      if (r === 0) {
        if (i === 1)  return 'i';
        if (i === -1) return '-i';
        return formatReal(i) + 'i';
      }
      const sign = i > 0 ? ' + ' : ' - ';
      const absI = Math.abs(i);
      const iStr = (absI === 1) ? 'i' : (formatReal(absI) + 'i');
      return formatReal(r) + sign + iStr;
    };
    function formatReal(v) {
      if (Number.isInteger(v)) return String(v);
      if (Math.abs(v) < 1e-4 || Math.abs(v) >= 1e7) return v.toExponential(6);
      return (+v.toPrecision(10)).toString();
    }
    return C;
  })();
  const _I = new Complex(0, 1);
  const _toC = (x) => (x instanceof Complex) ? x : new Complex(x, 0);

  // BigInt 浮点除法: JS BigInt 不能直接除, 这里用前 16 位有效数字 + 10^k 给出近似值
  //   - 1 / 10^1000  ->  字符串 "1e-1000"  (number 装不下 1e-1000, 只能给字符串)
  //   - 10^1000 / 3  ->  字符串 "3.333333e+999"
  //   - 2^100 / 3^50 ->  number  1.65e+12  (能装进 number)
  //   牺牲精度换可读性, 想要 100+ 位小数请用 Python 后端
  //
  //   算法:  a = aMant × 10^max(0, aLen-16),  b = bMant × 10^max(0, bLen-16)
  //          (aLen<16 时 a 就 = aMant, 没有 10^k 修正)
  //          a/b = (aMant/bMant) × 10^(max(0,aLen-16) - max(0,bLen-16))
  //   边界:  number 范围约 [1.8e-308, 1.8e308], 超出则用科学记数法字符串
  function bigDiv(a, b) {
    if (typeof a !== 'bigint') a = BigInt(Math.trunc(a));
    if (typeof b !== 'bigint') b = BigInt(Math.trunc(b));
    if (b === 0n) return NaN;
    if (a === 0n) return 0;

    const sign = (a < 0n) === (b < 0n) ? 1 : -1;
    const A = a < 0n ? -a : a;
    const B = b < 0n ? -b : b;

    const aStr = A.toString();
    const bStr = B.toString();
    const aLen = aStr.length;
    const bLen = bStr.length;

    // 取前 16 位数字 (不足就全要)
    const PREFIX = 16;
    const aMant = Number(aStr.slice(0, Math.min(PREFIX, aStr.length)));
    const bMant = Number(bStr.slice(0, Math.min(PREFIX, bStr.length)));

    // a = aMant × 10^max(0, aLen-16),  aLen<16 时 a 真的 = aMant
    const aExp = Math.max(0, aLen - PREFIX);
    const bExp = Math.max(0, bLen - PREFIX);
    const exp = aExp - bExp;

    // a/b = (aMant/bMant) × 10^exp
    const ratio = aMant / bMant;            // 约 1e-16 .. 1e16
    const absRatio = Math.abs(ratio);
    const rLog10 = Math.log10(absRatio);    // 整数 (因为 a/b 通常是 10 的整数幂之比)
    const E = Math.floor(rLog10) + exp;     // 真实 10 指数
    // 规约 mantissa 到 [1, 10)
    //   ratio = mantissa × 10^floor(rLog10)  =>  mantissa = ratio / 10^floor(rLog10)
    //   例:  ratio=1e-15,  floor=−15  =>  mantissa = 1e-15 / 1e-15 = 1
    const mantissa = sign * absRatio / Math.pow(10, Math.floor(rLog10));

    // 指数在 number 范围内 (+/-308) 就用 number, 否则用字符串
    if (E > 308) return mantissa.toFixed(6).replace(/\.?0+$/, '') + 'e+' + E;
    if (E < -308) return mantissa.toFixed(6).replace(/\.?0+$/, '') + 'e' + E;
    // 装得下: 用 number 表示
    //   mantissa 正好是 ±1 说明结果就是精确的 10^E
    //   走 number 会有 1 ULP 误差 (例如 1/10^20 -> 1.0000000000000001e-20 而不是 1e-20)
    //   因为 10^20 在 double 里不精确, 1/1e20 跟字面量 1e-20 不是同一个 double
    //   这种"结果本应是 10 的幂"的情况, 用字符串直接给出精确值
    if (Math.abs(mantissa) === 1) {
      return (sign < 0 ? '-' : '') + '1e' + (E > 0 ? '+' + E : E);
    }
    return sign * absRatio * Math.pow(10, exp);
  }

  // 工具: 把 number 转成"不丢精度"的字符串
  //   - 普通 number:  Number(1.23)  ->  "1.23"  (经 toString)
  //   - 极小数 (下溢为 0 但实际非零):  Number("1e-500") 是 0, 但我们要 "1e-500"
  //     这种情况发生在 tokenize 时小数位数太多被 IEEE 754 截断 -> 无法在这里恢复
  //   - 极大/极小数本身已经是 0 / Infinity: 保留原始输入 (通过 _origStr 字段)
  function numToString(v) {
    if (typeof v === 'string') return v;   // bigDiv 已经给了字符串
    if (typeof v === 'bigint') return v.toString();
    if (v && v._origStr) return v._origStr;  // 极小/极大字面量, 保留原始字符串
    return String(v);
  }

  /* ============================================================
   * 求值器 (Evaluator)
   * ============================================================ */
  const CONSTANTS = {
    pi: Math.PI,
    PI: Math.PI,
    e: Math.E,
    E: Math.E,
    tau: Math.PI * 2,
    TAU: Math.PI * 2,
    phi: (1 + Math.sqrt(5)) / 2,
    PHI: (1 + Math.sqrt(5)) / 2,
    i: _I,                    // 虚数单位 (注意: 跟用户变量同名时优先变量)
    I: _I,
    j: _I,                    // 工程界习惯
    J: _I,
    inf: Infinity,
    Inf: Infinity,
    INF: Infinity,
    nan: NaN,
    NaN: NaN
  };

  const FUNCTIONS = {
    // 三角 (实数域外自动返回复数)
    sin: Math.sin, cos: Math.cos, tan: Math.tan,
    asin: (x) => {
      if (x instanceof Complex) return _I.neg().mul(_I.mul(x).add(new Complex(1, 0).sub(x.mul(x)).sqrt()).ln());
      if (typeof x === 'number' && x >= -1 && x <= 1) return Math.asin(x);
      // |x| > 1: 复数域 asin(x) = -i * ln(ix + sqrt(1 - x^2))
      const ix = new Complex(0, x);
      return _I.neg().mul(ix.add(new Complex(1 - x * x, 0).sqrt()).ln());
    },
    acos: (x) => {
      if (x instanceof Complex) return _I.mul(x.add(new Complex(1, 0).sub(x.mul(x)).sqrt()).ln());
      if (typeof x === 'number' && x >= -1 && x <= 1) return Math.acos(x);
      // |x| > 1: acos(x) = pi/2 - asin(x)
      const asinVal = FUNCTIONS.asin(x);  // 复用上面的 asin, 已经是复数
      return new Complex(Math.PI / 2, 0).sub(asinVal);
    },
    atan: Math.atan, atan2: Math.atan2,
    // 双曲 (实数域外自动返回复数)
    sinh: (x) => {
      if (x instanceof Complex) {
        const e1 = x.exp(), e2 = x.neg().exp();
        return e1.sub(e2).div(new Complex(2, 0));
      }
      return Math.sinh(x);
    },
    cosh: (x) => {
      if (x instanceof Complex) {
        const e1 = x.exp(), e2 = x.neg().exp();
        return e1.add(e2).div(new Complex(2, 0));
      }
      return Math.cosh(x);
    },
    tanh: (x) => {
      if (x instanceof Complex) {
        const e1 = x.exp(), e2 = x.neg().exp();
        return e1.sub(e2).div(e1.add(e2));
      }
      return Math.tanh(x);
    },
    asinh: (x) => {
      if (x instanceof Complex) return x.add(x.mul(x).add(new Complex(1, 0)).sqrt()).ln();
      return Math.asinh(x);  // asinh 在整个实数域都有定义
    },
    acosh: (x) => {
      if (x instanceof Complex) return x.add(x.mul(x).sub(new Complex(1, 0)).sqrt()).ln();
      if (typeof x === 'number' && x >= 1) return Math.acosh(x);
      // x < 1: 复数
      return FUNCTIONS.acosh(new Complex(x, 0));
    },
    atanh: (x) => {
      if (x instanceof Complex) {
        return new Complex(0.5, 0).mul(
          new Complex(1, 0).add(x).ln().sub(new Complex(1, 0).sub(x).ln())
        );
      }
      if (typeof x === 'number' && x > -1 && x < 1) return Math.atanh(x);
      // |x| >= 1: 复数
      return FUNCTIONS.atanh(new Complex(x, 0));
    },
    // 指数/对数 (实数域外自动返回复数)
    log: (x) => {  // 兼容: log = log10
      if (x instanceof Complex) {
        const ln = x.ln();
        return new Complex(ln.re / Math.LN10, ln.im / Math.LN10);
      }
      if (typeof x === 'number') {
        if (x > 0) return Math.log10(x);
        if (x === 0) return -Infinity;
        // x < 0
        return new Complex(Math.log10(-x), Math.PI / Math.LN10);
      }
      return Math.log10(x);
    },
    log10: (x) => {
      if (x instanceof Complex) {
        const ln = x.ln();
        return new Complex(ln.re / Math.LN10, ln.im / Math.LN10);
      }
      if (typeof x === 'number') {
        if (x > 0) return Math.log10(x);
        if (x === 0) return -Infinity;
        return new Complex(Math.log10(-x), Math.PI / Math.LN10);
      }
      return Math.log10(x);
    },
    ln: (x) => {
      if (x instanceof Complex) return x.ln();
      if (typeof x === 'number') {
        if (x > 0) return Math.log(x);
        if (x === 0) return -Infinity;
        return new Complex(Math.log(-x), Math.PI);
      }
      return Math.log(x);
    },
    log2: (x) => {
      if (x instanceof Complex) {
        const ln = x.ln();
        return new Complex(ln.re / Math.LN2, ln.im / Math.LN2);
      }
      if (typeof x === 'number') {
        if (x > 0) return Math.log2(x);
        if (x === 0) return -Infinity;
        return new Complex(Math.log2(-x), Math.PI / Math.LN2);
      }
      return Math.log2(x);
    },
    exp: (x) => {
      if (x instanceof Complex) return x.exp();
      return Math.exp(x);
    },
    sqrt: (x) => {
      if (x instanceof Complex) return x.sqrt();
      if (typeof x === 'number') {
        if (x >= 0) return Math.sqrt(x);
        return new Complex(0, Math.sqrt(-x));
      }
      return Math.sqrt(x);
    },
    cbrt: (x) => {
      if (x instanceof Complex) return x.pow(new Complex(1 / 3, 0));
      return Math.cbrt(x);
    },
    // 其它
    abs: Math.abs,
    floor: Math.floor,
    ceil: Math.ceil,
    round: Math.round,
    trunc: Math.trunc,
    sign: Math.sign,
    min: function () { return Math.min.apply(null, arguments); },
    max: function () { return Math.max.apply(null, arguments); },
    pow: Math.pow,
    fact: function (n) {
      if (n < 0 || n !== Math.floor(n)) throw new Error('fact() requires non-negative integer');
      let r = 1;
      for (let i = 2; i <= n; i++) r *= i;
      return r;
    }
  };

  // 阶乘后缀 n!
  function factorial(n) {
    if (n < 0 || n !== Math.floor(n)) throw new Error('! requires non-negative integer');
    let r = 1;
    for (let i = 2; i <= n; i++) r *= i;
    return r;
  }

  /* ============================================================
   * 高阶函数: sum / product / diff / integrate / limit
   *   这些函数要拿 sub-AST, 不能放进 FUNCTIONS 表 (FUNCTIONS 拿到的是已求值结果)
   *   所以在 evaluateAst 的 'func' 分支里直接 dispatch
   * ============================================================ */

  // 提取 var 节点的名字, 否则报错
  function _expectVar(argAst, funcName) {
    if (!argAst || argAst.type !== 'var') {
      throw new Error(funcName + '() 的参数必须是变量名 (如 x)');
    }
    return argAst.name;
  }

  // 把任意值转成 number (Complex 取 re, BigInt 安全范围内取 Number)
  function _toNum(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'bigint') {
      if (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return Number(v);
      }
      throw new Error('数值超出 number 范围: ' + v.toString().slice(0, 20) + '...');
    }
    if (v instanceof Complex) {
      if (Math.abs(v.im) > 1e-12) throw new Error('需要实数, 拿到复数');
      return v.re;
    }
    throw new Error('无法转换为数字: ' + typeof v);
  }

  // 把整数 from/to 转 BigInt, 校验
  function _toBigIntRange(v, name) {
    let b;
    if (typeof v === 'bigint') b = v;
    else if (typeof v === 'number' && Number.isInteger(v)) b = BigInt(v);
    else if (typeof v === 'number') throw new Error(name + ' 必须是整数, 拿到 ' + v);
    else throw new Error(name + ' 必须是整数');
    return b;
  }

  // 自适应 Simpson 积分 (递归)
  //   在 [a,b] 上对 f 积分, 终止条件: |S12 - S| < 15*tol 或 depth 耗尽
  //   返回 Richardson 外推后的值, 精度约 1e-12~1e-14
  function _adaptiveSimpson(f, a, b, tol, maxDepth) {
    function simpson(fa, fb, fm, h) { return (h / 3) * (fa + 4 * fm + fb); }
    const c = (a + b) / 2;
    const h = b - a;
    const fa = f(a), fb = f(b), fc = f(c);
    const S = simpson(fa, fb, fc, h);
    return _simpsonRec(f, a, b, fa, fb, fc, S, tol, maxDepth);
  }
  function _simpsonRec(f, a, b, fa, fb, fc, S, tol, depth) {
    const c = (a + b) / 2;
    const d = (a + c) / 2;
    const e = (c + b) / 2;
    const fd = f(d), fe = f(e);
    const h = b - a;
    const Sleft  = (h / 12) * (fa + 4 * fd + fc);
    const Sright = (h / 12) * (fc + 4 * fe + fb);
    const S12 = Sleft + Sright;
    if (depth <= 0 || Math.abs(S12 - S) < 15 * tol) {
      return S12 + (S12 - S) / 15;  // Richardson 外推
    }
    return _simpsonRec(f, a, c, fa, fc, fd, Sleft,  tol / 2, depth - 1) +
           _simpsonRec(f, c, b, fc, fb, fe, Sright, tol / 2, depth - 1);
  }

  // 数值求和:  sum(变量, 下界, 上界, 表达式)
  //   - 整数迭代 (用 BigInt 避免 i 越界)
  //   - 整数结果用 BigInt 累加, 浮点/复数结果用 Complex 累加
  //   - 全整数且能装进 number 时返回 number, 否则返回 BigInt
  //   - 安全上限 1e7 项
  function _evalSum(args, baseVars) {
    if (args.length !== 4) throw new Error('sum() 需要 4 个参数: sum(变量, 下界, 上界, 表达式)');
    const varName = _expectVar(args[0], 'sum');
    const fromI = _toBigIntRange(evaluateAst(args[1], baseVars), 'sum 下界');
    const toI   = _toBigIntRange(evaluateAst(args[2], baseVars), 'sum 上界');
    const exprAst = args[3];
    if (fromI > toI) return 0;  // 空和

    const MAX_ITER = 10000000n;
    if (toI - fromI + 1n > MAX_ITER) {
      throw new Error('sum() 范围太大 (>1e7), 上界减下界请 ≤ 10000000');
    }

    let bigAcc = 0n;
    let acc = new Complex(0, 0);
    let isExact = true;

    for (let i = fromI; i <= toI; i++) {
      const vars = Object.assign({}, baseVars);
      vars[varName] = Number(i);  // 表达式里变量还是用 number
      const v = evaluateAst(exprAst, vars);
      if (typeof v === 'bigint') {
        bigAcc += v;
      } else if (typeof v === 'number' && Number.isInteger(v)) {
        bigAcc += BigInt(v);
      } else if (typeof v === 'number') {
        isExact = false;
        acc = acc.add(new Complex(v, 0));
      } else if (v instanceof Complex) {
        if (Math.abs(v.im) < 1e-12 && Number.isInteger(v.re)) {
          bigAcc += BigInt(v.re);
        } else {
          isExact = false;
          acc = acc.add(v);
        }
      } else {
        throw new Error('sum() 表达式返回了不支持的类型');
      }
    }

    if (isExact) {
      if (bigAcc >= BigInt(Number.MIN_SAFE_INTEGER) && bigAcc <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return Number(bigAcc);
      }
      return bigAcc;
    }
    // 混合: 把整数部分加到 acc
    if (bigAcc !== 0n) acc = acc.add(new Complex(Number(bigAcc), 0));
    if (Math.abs(acc.im) < 1e-12) return acc.re;
    return acc;
  }

  // 数值求积:  product(变量, 下界, 上界, 表达式)
  function _evalProduct(args, baseVars) {
    if (args.length !== 4) throw new Error('product() 需要 4 个参数: product(变量, 下界, 上界, 表达式)');
    const varName = _expectVar(args[0], 'product');
    const fromI = _toBigIntRange(evaluateAst(args[1], baseVars), 'product 下界');
    const toI   = _toBigIntRange(evaluateAst(args[2], baseVars), 'product 上界');
    const exprAst = args[3];
    if (fromI > toI) return 1;  // 空积

    const MAX_ITER = 10000000n;
    if (toI - fromI + 1n > MAX_ITER) {
      throw new Error('product() 范围太大 (>1e7)');
    }

    let acc = new Complex(1, 0);
    for (let i = fromI; i <= toI; i++) {
      const vars = Object.assign({}, baseVars);
      vars[varName] = Number(i);
      const v = evaluateAst(exprAst, vars);
      acc = acc.mul(_toC(v));
    }
    if (Math.abs(acc.im) < 1e-12) return acc.re;
    return acc;
  }

  // 数值求导:  diff(表达式, 变量)
  //   - 中心差分:  f'(x) ≈ (f(x+h) - f(x-h)) / (2h)
  //   - 步长:  h = max(|x|·1e-5, 1e-8), x=0 时取 1e-5
  //   - 变量当前值:  在 baseVars 里, 缺省 0
  function _evalDiff(args, baseVars) {
    if (args.length !== 2) throw new Error('diff() 需要 2 个参数: diff(表达式, 变量)');
    const exprAst = args[0];
    const varName = _expectVar(args[1], 'diff');
    const x0 = (baseVars && Object.prototype.hasOwnProperty.call(baseVars, varName))
                ? _toNum(baseVars[varName]) : 0;
    let h;
    if (x0 === 0) h = 1e-5;
    else h = Math.max(Math.abs(x0) * 1e-5, 1e-10);

    function f(x) {
      const vars = Object.assign({}, baseVars);
      vars[varName] = x;
      return evaluateAst(exprAst, vars);
    }

    const fp = _toC(f(x0 + h));
    const fm = _toC(f(x0 - h));
    const deriv = fp.sub(fm).div(new Complex(2 * h, 0));
    if (Math.abs(deriv.im) < 1e-12) return deriv.re;
    return deriv;
  }

  // 数值积分:  integrate(表达式, 变量, 下界, 上界)
  //   - 自适应 Simpson, 递归深度上限 50, 终止容差 1e-12
  //   - 区间过大 (|b-a| > 1e9) 会按子区间分段 (每段 1e6) 再相加
  function _evalIntegrate(args, baseVars) {
    if (args.length !== 4) throw new Error('integrate() 需要 4 个参数: integrate(表达式, 变量, 下界, 上界)');
    const exprAst = args[0];
    const varName = _expectVar(args[1], 'integrate');
    const a = _toNum(evaluateAst(args[2], baseVars));
    const b = _toNum(evaluateAst(args[3], baseVars));
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      throw new Error('integrate() 上下界必须是有限数');
    }

    function f(x) {
      const vars = Object.assign({}, baseVars);
      vars[varName] = x;
      return evaluateAst(exprAst, vars);
    }

    // 区间太宽分段求和 (避免单次递归深度/精度问题)
    const MAX_SEG = 1e6;
    if (Math.abs(b - a) <= MAX_SEG) {
      const r = _adaptiveSimpson(f, a, b, 1e-12, 50);
      return Math.abs(r) < 1e-15 ? 0 : r;
    }
    const N = Math.ceil(Math.abs(b - a) / MAX_SEG);
    const step = (b - a) / N;
    let total = 0;
    for (let i = 0; i < N; i++) {
      const segA = a + i * step;
      const segB = segA + step;
      try { total += _adaptiveSimpson(f, segA, segB, 1e-9, 30); }
      catch (e) { /* 单段失败跳过, 留给主段平均 */ }
    }
    return total;
  }

  // 数值极限:  limit(表达式, 变量, 趋近点)
  //   - 从两侧用 h = 1e-1, 1e-2, ..., 1e-10 趋近
  //   - 两侧都有限且差 < 1e-6  →  返回均值
  //   - 一侧发散 / 两侧不同    →  返回最稳定的单侧值 (右侧优先) 或 NaN
  //   - 趋近点为 ±∞ 时用大数 1e10 替代
  function _evalLimit(args, baseVars) {
    if (args.length !== 3) throw new Error('limit() 需要 3 个参数: limit(表达式, 变量, 趋近点)');
    const exprAst = args[0];
    const varName = _expectVar(args[1], 'limit');
    const pointRaw = evaluateAst(args[2], baseVars);
    const point = _toNum(pointRaw);

    function f(x) {
      const vars = Object.assign({}, baseVars);
      vars[varName] = x;
      try { return _toNum(evaluateAst(exprAst, vars)); } catch (e) { return NaN; }
    }

    // 趋近点是 ±∞ 时, 改用 1e10 那一侧
    if (point === Infinity || point === -Infinity) {
      const x = point > 0 ? 1e10 : -1e10;
      const v = f(x);
      return Number.isFinite(v) ? v : NaN;
    }

    // ★ 1^∞ 型检测:  形如 f(x)^g(x), f(point)=1 且 g(point)=±∞
    //   数值上直接 f(point+h) 会因为 1+δ 失精度 (δ < 1e-10 后舍入误差主导)
    //   标准解法: 改求 exp(limit of g(x) * ln(f(x))), 内部是 0·∞ 化 0/0 用 L'Hopital 更稳
    //   数值上就是直接用 g·ln(f) 序列, 不再 f^g
    if (exprAst && exprAst.type === 'binop' && exprAst.op === '^') {
      const envAtPoint = Object.assign({}, baseVars, { [varName]: point });
      let baseAt = NaN, expAt = NaN;
      try { baseAt = _toNum(evaluateAst(exprAst.left, envAtPoint)); } catch (e) { baseAt = NaN; }
      try { expAt  = _toNum(evaluateAst(exprAst.right, envAtPoint)); } catch (e) { expAt = NaN; }
      if (baseAt === 1 && !Number.isFinite(expAt) && Math.abs(expAt) > 1e6) {
        // 构造新 AST: g(x) * ln(f(x)), 递归求 limit
        const innerAst = { type: 'binop', op: '*',
          left: exprAst.right,
          right: { type: 'func', name: 'ln', args: [exprAst.left] }
        };
        const innerLimit = _evalLimit([innerAst, args[1], args[2]], baseVars);
        if (Number.isFinite(innerLimit)) return Math.exp(innerLimit);
        // fall through to default
      }
    }

    // 用 Richardson 序列 (h = 2^-n) + Aitken Δ² 加速
    //   旧版 h = 1e-1..1e-10 固定 8 个点, 对 1^∞ 类精度灾难 (下表 1e-10 反而比 1e-8 差)
    //   Aitken:  L ≈ v_n - (v_n - v_{n+1})² / (v_n - 2v_{n+1} + v_{n+2})
    //           从最后 3 个值推一个收敛更快的估计
    const N = 20;
    const hs = [];
    for (let i = 0; i < N; i++) hs.push(Math.pow(2, -i));   // 1, 0.5, 0.25, ..., ~1e-6
    const left = [], right = [];
    for (const h of hs) {
      const l = f(point - h);
      const r = f(point + h);
      if (Number.isFinite(l)) left.push(l);
      if (Number.isFinite(r)) right.push(r);
    }
    if (left.length === 0 && right.length === 0) return NaN;

    // Aitken Δ² 加速
    function aitken(seq) {
      if (seq.length < 3) return seq[seq.length - 1];
      const a = seq[seq.length - 1];   // 最近 (h 最小)
      const b = seq[seq.length - 2];
      const c = seq[seq.length - 3];
      const d = a - 2 * b + c;
      // 退化情况 (序列已收敛 / 完全震荡)
      if (Math.abs(d) < 1e-15 * Math.max(1, Math.abs(a))) return a;
      const v = a - (a - b) * (a - b) / d;
      return Number.isFinite(v) ? v : a;
    }
    const aL = left.length  >= 3 ? aitken(left)  : left[left.length - 1];
    const aR = right.length >= 3 ? aitken(right) : right[right.length - 1];

    // 两侧都有限, 差 < 1e-6 倍幅 → 取均值 (比单侧更准)
    if (Number.isFinite(aL) && Number.isFinite(aR)) {
      const scale = Math.max(1, Math.abs((aL + aR) / 2));
      if (Math.abs(aL - aR) <= 1e-6 * scale) return (aL + aR) / 2;
    }
    if (Number.isFinite(aR)) return aR;
    if (Number.isFinite(aL)) return aL;
    return NaN;
  }

  function evaluateAst(ast, vars) {
    vars = vars || {};
    switch (ast.type) {
      case 'num':
        if (ast._origStr) {
          // 极小/极大字面量下溢/上溢成 number, 装在 number 旁保留原始字符串
          //   输出时 (如 formatNum) 通过 numToString 还原成 "1e-1001" 之类
          return Object.assign(Object(ast.value), { _origStr: ast._origStr });
        }
        return ast.value;
      case 'var':
        if (Object.prototype.hasOwnProperty.call(vars, ast.name)) return vars[ast.name];
        if (ast.name in CONSTANTS) return CONSTANTS[ast.name];
        throw new Error('Unknown variable: ' + ast.name);
      case 'binop': {
        const a = evaluateAst(ast.left, vars);
        const b = evaluateAst(ast.right, vars);
        // 复数运算
        if (a instanceof Complex || b instanceof Complex) {
          const ca = _toC(a), cb = _toC(b);
          switch (ast.op) {
            case '+': return ca.add(cb);
            case '-': return ca.sub(cb);
            case '*': return ca.mul(cb);
            case '/': return ca.div(cb);
            case '^': return ca.pow(cb);
            case '%': throw new Error('Complex % is not supported');
          }
        }
        // BigInt 参与运算 (^ 已经单独处理了精确整数幂):
        //   + - * % 用 BigInt 路径, 精确无丢位
        //   / 特殊处理: 1 / 10^1000 算不出精确小数 (JS 没有), 用科学记数法估算
        if (typeof a === 'bigint' || typeof b === 'bigint') {
          if (ast.op === '/') return bigDiv(a, b);
          const A = typeof a === 'bigint' ? a : BigInt(Math.trunc(a));
          const B = typeof b === 'bigint' ? b : BigInt(Math.trunc(b));
          switch (ast.op) {
            case '+': return A + B;
            case '-': return A - B;
            case '*': return A * B;
            case '%':
              if (B === 0n) return NaN;
              return A % B;
          }
        }
        switch (ast.op) {
          case '+': return a + b;
          case '-': return a - b;
          case '*': return a * b;
          case '/': return a / b;
          case '%': return a % b;
          case '^':
            // 整数底数 + 非负整数指数 -> BigInt 精确计算, 避免 Math.pow 丢精度
            //   例: 100^50 = 10^100, Math.pow 只准 15 位, 后面全是垃圾位
            //   小结果 (|值| <= 2^53 安全整数) 转回 number, 保持与旧代码兼容
            //   排除: 2.5^3 (非整数底), 2^-3 (负指数), 2^0.5 (小数指数)
            if (Number.isInteger(a) && Number.isInteger(b) && b >= 0
                && a >= Number.MIN_SAFE_INTEGER && a <= Number.MAX_SAFE_INTEGER) {
              const big = BigInt(a) ** BigInt(b);
              if (big <= BigInt(Number.MAX_SAFE_INTEGER)
                  && big >= BigInt(Number.MIN_SAFE_INTEGER)) {
                return Number(big);   // 小整数: 转回 number 保持兼容
              }
              return big;             // 大整数: 保留 BigInt 精确值
            }
            return Math.pow(a, b);
        }
        throw new Error('Unknown binary operator: ' + ast.op);
      }
      case 'unary': {
        const v = evaluateAst(ast.operand, vars);
        switch (ast.op) {
          case '+': return v;
          case '-': return v instanceof Complex ? v.neg() : -v;
          case '!': return factorial(v);
        }
        throw new Error('Unknown unary operator: ' + ast.op);
      }
      case 'func': {
        // 高阶函数: 需要 sub-AST, 走特殊 dispatch (FUNCTIONS 表里只放普通纯函数)
        if (ast.name === 'sum')      return _evalSum(ast.args, vars);
        if (ast.name === 'product')  return _evalProduct(ast.args, vars);
        if (ast.name === 'diff')     return _evalDiff(ast.args, vars);
        if (ast.name === 'integrate') return _evalIntegrate(ast.args, vars);
        if (ast.name === 'limit')    return _evalLimit(ast.args, vars);

        const fn = FUNCTIONS[ast.name];
        if (!fn) throw new Error('Unknown function: ' + ast.name + '()');
        if (ast.args.length === 1) {
          return fn(evaluateAst(ast.args[0], vars));
        }
        const args = new Array(ast.args.length);
        for (let i = 0; i < ast.args.length; i++) {
          args[i] = evaluateAst(ast.args[i], vars);
        }
        return fn.apply(null, args);
      }
    }
    throw new Error('Unknown AST node type: ' + ast.type);
  }

  /* ============================================================
   * 方程预处理: 将 f(x) = g(x) 转为 f(x) - g(x)
   * ============================================================ */
  function buildEquationAst(input) {
    const eqIdx = input.indexOf('=');
    if (eqIdx === -1) return parse(input);
    if (input.indexOf('=', eqIdx + 1) !== -1) {
      throw new Error('Equation must have at most one "="');
    }
    const lhs = input.substring(0, eqIdx).trim();
    const rhs = input.substring(eqIdx + 1).trim();
    if (!lhs || !rhs) throw new Error('Both sides of "=" must be non-empty');
    const left = parse(lhs);
    const right = parse(rhs);
    return { type: 'binop', op: '-', left, right };
  }

  // 在 AST 中收集出现的所有变量名
  function collectVariables(ast, out) {
    out = out || {};
    if (!ast) return out;
    switch (ast.type) {
      case 'num': break;
      case 'var': out[ast.name] = true; break;
      case 'binop':
        collectVariables(ast.left, out); collectVariables(ast.right, out); break;
      case 'unary': collectVariables(ast.operand, out); break;
      case 'func': ast.args.forEach(a => collectVariables(a, out)); break;
    }
    return out;
  }

  /* ============================================================
   * 数值求根 (Bisection + Newton + 解析二次公式)
   * ============================================================ */
  function solveAst(ast, varName, options) {
    options = options || {};
    const start = options.start != null ? options.start : config.sampleDomain[0];
    const end   = options.end   != null ? options.end   : config.sampleDomain[1];
    const samples = options.samples != null ? options.samples : config.sampleCount;
    const eps    = options.epsilon != null ? options.epsilon : config.epsilon;
    const maxIter = options.maxIter != null ? options.maxIter : config.maxIter;
    const timeout = options.timeout != null ? options.timeout : config.timeout;
    const extraVars = options.vars || {};  // 外部传入的常量变量 (除了 varName)

    // 快速路径: 二次方程 ax^2+bx+c=0  ->  解析公式
    const quad = detectQuadratic(ast, varName);
    if (quad) {
      const [a, b, c] = quad;
      return solveQuadraticFormula(a, b, c);
    }

    // 快速路径: 高次多项式  ->  Newton 迭代 + 复平面撒点
    const poly = collectPolyAll(ast, varName, 30);
    if (poly) {
      return findPolynomialRoots(poly);
    }

    const vars = Object.assign({}, extraVars);  // 预填外部常量
    function f(x) {
      vars[varName] = x;
      return evaluateAst(ast, vars);
    }

    const deadline = Date.now() + timeout;
    const roots = [];
    const seen = new Set();

    function addRoot(r) {
      if (!isFinite(r)) return;
      const key = r.toFixed(10);
      if (seen.has(key)) return;
      seen.add(key);
      roots.push(r);
    }
    function checkTimeout() {
      if (Date.now() > deadline) throw new Error('Solver timeout (' + timeout + 'ms)');
    }

    // 1) 采样找变号区间 & 重根 (切根)
    const step = (end - start) / samples;
    const xs = new Array(samples + 1);
    const fs = new Array(samples + 1);
    for (let i = 0; i <= samples; i++) {
      checkTimeout();
      const x = start + i * step;
      xs[i] = x;
      let y;
      try { y = f(x); } catch (e) { y = NaN; }
      fs[i] = y;
    }
    // 重根检测: 找 |f| 真正接近 0 的区域, 用绝对值门槛 (不依赖函数大小)
    // 避免 x^2+2x+3 这类函数被误判: 其极小值=2, 不应被当成根
    const NEAR_ZERO = 1.0;     // |f| < 1.0 才算"近零区域"
    const ROOT_TOL  = 1e-6;    // 残差 < 1e-6 才算真根
    let k = 0;
    while (k <= samples) {
      if (!isFinite(fs[k]) || Math.abs(fs[k]) >= NEAR_ZERO) { k++; continue; }
      let j = k;
      while (j <= samples && isFinite(fs[j]) && Math.abs(fs[j]) < NEAR_ZERO) j++;
      if (j - k >= 2) {
        const lo = xs[k], hi = xs[Math.min(j, samples)];
        const fLo = fs[k], fHi = fs[j - 1];
        if (fLo * fHi >= 0) {
          // 不变号 -> 用黄金分割在 [lo, hi] 内找 |f| 极小
          const gr = (Math.sqrt(5) - 1) / 2;
          let aLo = lo, aHi = hi;
          let c = aHi - gr * (aHi - aLo), d = aLo + gr * (aHi - aLo);
          let fc = NaN, fd = NaN;
          try { fc = Math.abs(f(c)); } catch (e) {}
          try { fd = Math.abs(f(d)); } catch (e) {}
          for (let it = 0; it < 80; it++) {
            checkTimeout();
            if (aHi - aLo < eps * Math.max(1, Math.abs(aHi))) break;
            if (fc < fd) { aHi = d; d = c; fd = fc; c = aHi - gr * (aHi - aLo); try { fc = Math.abs(f(c)); } catch (e) { fc = NaN; } }
            else { aLo = c; c = d; fc = fd; d = aLo + gr * (aHi - aLo); try { fd = Math.abs(f(d)); } catch (e) { fd = NaN; } }
          }
          const root = (aLo + aHi) / 2;
          // 严格验证: 残差必须 < 1e-6 才算真根
          try {
            if (Math.abs(f(root)) < ROOT_TOL) addRoot(root);
          } catch (e) {}
        }
      }
      k = j;
    }

    // 2) 在每个变号区间做二分
    for (let i = 0; i < samples; i++) {
      checkTimeout();
      const a = xs[i], b = xs[i + 1];
      const fa = fs[i], fb = fs[i + 1];
      if (!isFinite(fa) || !isFinite(fb)) continue;
      if (Math.abs(fa) < eps) { addRoot(a); continue; }
      if (fa * fb < 0) {
        let lo = a, hi = b, flo = fa, fhi = fb;
        for (let it = 0; it < maxIter; it++) {
          checkTimeout();
          const mid = (lo + hi) / 2;
          let fmid;
          try { fmid = f(mid); } catch (e) { fmid = NaN; }
          if (!isFinite(fmid)) break;
          if (Math.abs(fmid) < eps || (hi - lo) < eps * Math.max(1, Math.abs(mid))) {
            addRoot(mid); break;
          }
          if (flo * fmid < 0) { hi = mid; fhi = fmid; } else { lo = mid; flo = fmid; }
        }
      }
    }

    // 3) 牛顿法补漏 (对采样点用数值导数)
    for (let i = 0; i <= samples; i += 4) {
      checkTimeout();
      const x0 = xs[i];
      const fx0 = fs[i];
      if (!isFinite(fx0) || Math.abs(fx0) < eps) continue;
      let x = x0;
      let converged = false;
      for (let it = 0; it < 30; it++) {
        checkTimeout();
        const h = 1e-7 * Math.max(1, Math.abs(x));
        let fxp, fxm;
        try { fxp = f(x + h); fxm = f(x - h); } catch (e) { break; }
        if (!isFinite(fxp) || !isFinite(fxm)) break;
        const deriv = (fxp - fxm) / (2 * h);
        if (Math.abs(deriv) < 1e-20) break;
        const xNew = x - fx0 / deriv;
        if (!isFinite(xNew)) break;
        if (Math.abs(xNew - x) < eps * Math.max(1, Math.abs(x))) {
          addRoot(xNew); converged = true; break;
        }
        x = xNew;
        // 重新计算 fx0
        try { fx0 = f(x); } catch (e) { break; }
        if (!isFinite(fx0)) break;
        if (Math.abs(fx0) < eps) { addRoot(x); converged = true; break; }
      }
      if (!converged && isFinite(x0)) {
        // 兜底
      }
    }

    return roots.sort(function (a, b) { return a - b; });
  }

  // 二次方程 ax^2+bx+c=0 的精确求根 (有复数根时返回 Complex)
  function solveQuadraticFormula(a, b, c) {
    if (a === 0) {
      if (b === 0) return [];
      return [-c / b];
    }
    const disc = b * b - 4 * a * c;
    if (disc < 0) {
      // 复数根: x = (-b ± i·sqrt(-disc)) / (2a)
      const re = -b / (2 * a);
      const im = Math.sqrt(-disc) / (2 * a);
      const r1 = new Complex(re,  im);
      const r2 = new Complex(re, -im);
      // 排序: 先实部后虚部 (跟实数情况风格保持一致)
      return (r1.re - r2.re) || (r1.im - r2.im) < 0 ? [r1, r2] : [r2, r1];
    }
    if (disc === 0) return [-b / (2 * a)];
    const sq = Math.sqrt(disc);
    return [(-b - sq) / (2 * a), (-b + sq) / (2 * a)].sort(function (a, b) { return a - b; });
  }

  // ============================================================
  // 高次多项式求根 (Aberth-Ehrlich 同步迭代 + 复平面撒点)
  //   - 输入: 系数数组 coeffs, 多项式为 c0 + c1*x + c2*x^2 + ... + cn*x^n, cn≠0
  //   - 输出: n 个根 (实数用 number, 复数用 Complex)
  //   - 思路: 在半径合适的圆上等距取 n 个起点, 用 AE 公式同步更新
  //     z_i := z_i - f(z_i) / [f'(z_i) * (1 - sum_{j≠i} 1/(z_i - z_j))]
  //     比单点 Newton 鲁棒, 立方收敛, 不会多根收敛到同一点
  // ============================================================
  function findPolynomialRoots(coeffs) {
    let n = coeffs.length - 1;
    while (n > 0 && coeffs[n] === 0) n--;
    if (n <= 0) return [];
    if (n === 1) return [-coeffs[0] / coeffs[1]];
    if (n === 2) return solveQuadraticFormula(coeffs[2], coeffs[1], coeffs[0]);

    // 单项化
    const c = new Array(n + 1);
    const cn = coeffs[n];
    for (let i = 0; i <= n; i++) c[i] = coeffs[i] / cn;

    // Cauchy 半径估计: R = 1 + max|c[i]/c[n]|
    let maxC = 0;
    for (let i = 0; i < n; i++) if (Math.abs(c[i]) > maxC) maxC = Math.abs(c[i]);
    const R = 1 + maxC;

    function f(z) {
      let r = new Complex(c[n], 0);
      for (let i = n - 1; i >= 0; i--) r = r.mul(z).add(new Complex(c[i], 0));
      return r;
    }
    function fp(z) {
      let r = new Complex(n * c[n], 0);
      for (let i = n - 1; i >= 1; i--) r = r.mul(z).add(new Complex(i * c[i], 0));
      return r;
    }

    // 等距 n 个起点 (在圆上加个小角度偏置避开对称点)
    const z = [];
    for (let k = 0; k < n; k++) {
      const theta = (2 * Math.PI * k) / n + 0.1;
      z.push(new Complex(R * Math.cos(theta), R * Math.sin(theta)));
    }

    // Aberth-Ehrlich 迭代
    const TOL = 1e-12;
    const MAX_ITER = 60;
    for (let iter = 0; iter < MAX_ITER; iter++) {
      let maxChange = 0;
      const next = [];
      for (let i = 0; i < n; i++) {
        const fz = f(z[i]);
        const fpz = fp(z[i]);
        if (fpz.abs() < 1e-18) { next.push(z[i]); continue; }
        // sum_{j≠i} 1/(z_i - z_j)
        let sum = new Complex(0, 0);
        for (let j = 0; j < n; j++) {
          if (j === i) continue;
          const diff = z[i].sub(z[j]);
          if (diff.abs() < 1e-18) continue;
          sum = sum.add(new Complex(diff.re / (diff.re * diff.re + diff.im * diff.im),
                                     -diff.im / (diff.re * diff.re + diff.im * diff.im)));
        }
        // Aberth 公式: dz = f(z_i) / (f'(z_i) - f(z_i) * sum)
        // (不是 f(z_i) / (f'(z_i) * (1 - sum)) 那个是错的)
        const fzSum = fz.mul(sum);
        const totalDenom = new Complex(fpz.re - fzSum.re, fpz.im - fzSum.im);
        if (totalDenom.abs() < 1e-18) { next.push(z[i]); continue; }
        // dz = fz / totalDenom
        const d = totalDenom.re * totalDenom.re + totalDenom.im * totalDenom.im;
        const dzRe = (fz.re * totalDenom.re + fz.im * totalDenom.im) / d;
        const dzIm = (fz.im * totalDenom.re - fz.re * totalDenom.im) / d;
        const dzAbs = Math.sqrt(dzRe * dzRe + dzIm * dzIm);
        next.push(new Complex(z[i].re - dzRe, z[i].im - dzIm));
        if (dzAbs > maxChange) maxChange = dzAbs;
      }
      for (let i = 0; i < n; i++) z[i] = next[i];
      if (maxChange < TOL) break;
    }

    // 去重 (理论上 AE 不会让两个起点收敛到同一点, 但保险)
    const unique = [];
    const DEDUP_EPS = 1e-6;
    for (const r of z) {
      let dup = false;
      for (const u of unique) {
        if (r.sub(u).abs() < DEDUP_EPS) { dup = true; break; }
      }
      if (!dup) unique.push(r);
    }

    // 实数根 (im=0) 转回 number
    const out = [];
    for (const r of unique) {
      if (Math.abs(r.im) < 1e-9) out.push(r.re);
      else out.push(r);
    }
    return out;
  }

  // 通用多项式检测: 收集所有次数的系数 (0..n)
  //   - 表达式必须是 v 的多项式 (无 sin/exp/分式含 v 等)
  //   - 返回 [c0, c1, ..., cn], 失败返回 null
  //   - 与 collectPoly 共享 walk 逻辑, 但不限制次数
  function collectPolyAll(ast, v, maxDeg) {
    maxDeg = maxDeg || 30;  // 安全上限, 防恶意输入卡死
    const r = new Array(maxDeg + 1).fill(0);
    function walk(node, sign) {
      if (!node) return;
      if (node.type === 'num') { r[0] += sign * node.value; return; }
      if (node.type === 'var') {
        if (node.name === v) { r[1] += sign * 1; return; }
        throw new Error('not poly');
      }
      if (node.type === 'unary') {
        if (node.op === '-') walk(node.operand, -sign);
        else if (node.op === '+') walk(node.operand, sign);
        else throw new Error('not poly');
        return;
      }
      if (node.type === 'binop') {
        if (node.op === '+') { walk(node.left, sign); walk(node.right, sign); return; }
        if (node.op === '-') { walk(node.left, sign); walk(node.right, -sign); return; }
        if (node.op === '*') {
          const dl = polyDegree(node.left, v);
          const dr = polyDegree(node.right, v);
          if (dl < 0 || dr < 0) throw new Error('not poly');
          const deg = dl + dr;
          if (deg > maxDeg) throw new Error('degree too high');
          let coef;
          if (dl === 0)      coef = evalConst(node.left, v);
          else if (dr === 0) coef = evalConst(node.right, v);
          else throw new Error('not poly');
          r[deg] += sign * coef;
          return;
        }
        if (node.op === '/') {
          const dl = polyDegree(node.left, v);
          const dr = polyDegree(node.right, v);
          if (dl !== 0 || dr !== 0) throw new Error('not poly');
          r[0] += sign * (evalConst(node.left, v) / evalConst(node.right, v));
          return;
        }
        if (node.op === '^') {
          const dl = polyDegree(node.left, v);
          const dr = evalConst(node.right, v);
          if (dl !== 1) throw new Error('not poly');
          if (dr < 0 || dr !== Math.floor(dr)) throw new Error('not poly');
          if (dr > maxDeg) throw new Error('degree too high');
          r[dr] += sign * 1;
          return;
        }
      }
      throw new Error('not poly');
    }
    try {
      walk(ast, 1);
      // 找最高非零次
      let top = maxDeg;
      while (top > 0 && r[top] === 0) top--;
      if (top < 1) return null;
      return r.slice(0, top + 1);
    } catch (e) { return null; }
  }

  // 检测 AST 是否为某变量 v 的二次多项式, 若是返回 [a,b,c] (即 a*v^2 + b*v + c)
  function detectQuadratic(ast, v) {
    if (!ast) return null;
    if (ast.type === 'binop' && ast.op === '-' &&
        ast.left.type === 'binop' && ast.left.op === '-' &&
        ast.right.type === 'num' && ast.right.value === 0) {
      // 来自 buildEquationAst 的形式: left - right (right 不应为 0); 此分支不易命中, 跳过
    }
    // 通用多项式: 对 v 提取系数
    const coeffs = collectPoly(ast, v);
    if (!coeffs) return null;
    const a = coeffs[2] || 0;
    const b = coeffs[1] || 0;
    const c = coeffs[0] || 0;
    if (a === 0) {
      if (b === 0) return null;
      return [0, b, c];
    }
    return [a, b, c];
  }

  // 在 AST 中收集关于 v 的多项式系数 (degree 0..2).  非多项式返回 null.
  function collectPoly(ast, v) {
    // 简单实现: 假定表达式是 v 的二次多项式 + 常数
    // 提取 v^2 / v / 常数 项的系数, 其余视作 0
    const r = [0, 0, 0];
    function walk(node, sign) {
      if (!node) return;
      if (node.type === 'num') { r[0] += sign * node.value; return; }
      if (node.type === 'var') {
        if (node.name === v) { r[1] += sign * 1; return; }
        throw new Error('not poly');
      }
      if (node.type === 'unary') {
        if (node.op === '-') walk(node.operand, -sign);
        else if (node.op === '+') walk(node.operand, sign);
        else throw new Error('not poly');
        return;
      }
      if (node.type === 'binop') {
        if (node.op === '+') { walk(node.left, sign); walk(node.right, sign); return; }
        if (node.op === '-') { walk(node.left, sign); walk(node.right, -sign); return; }
        if (node.op === '*') {
          // 两边都必须是常数或 v 或 v^2
          const dl = polyDegree(node.left, v);
          const dr = polyDegree(node.right, v);
          if (dl < 0 || dr < 0) throw new Error('not poly');
          const deg = dl + dr;
          if (deg > 2) throw new Error('not poly');
          // 系数: 选"含 v"的那一边视为 1, 选"纯常数"的那一边 evalConst
          // (不能用 evalConst(var v, v), 那个会抛 not const, 导致 2x 这类被误判为非多项式)
          let coef;
          if (dl === 0)      coef = evalConst(node.left, v);
          else if (dr === 0) coef = evalConst(node.right, v);
          else throw new Error('not poly');  // 两边都含 v, 不是单项式 (如 x*x)
          r[deg] += sign * coef;
          return;
        }
        if (node.op === '/') {
          // 仅允许 常数 / 常数
          const dl = polyDegree(node.left, v);
          const dr = polyDegree(node.right, v);
          if (dl !== 0 || dr !== 0) throw new Error('not poly');
          r[0] += sign * (evalConst(node.left, v) / evalConst(node.right, v));
          return;
        }
        if (node.op === '^') {
          //  v ^ n, n 必须是 0/1/2 的整数
          const dl = polyDegree(node.left, v);
          const dr = evalConst(node.right, v);
          if (dl !== 1) throw new Error('not poly');
          if (dr !== 0 && dr !== 1 && dr !== 2) throw new Error('not poly');
          r[dr] += sign * 1;
          return;
        }
      }
      throw new Error('not poly');
    }
    try {
      walk(ast, 1);
      return r;
    } catch (e) { return null; }
  }

  function polyDegree(node, v) {
    if (!node) return -1;
    if (node.type === 'num') return 0;
    if (node.type === 'var') return node.name === v ? 1 : -1;
    if (node.type === 'unary' && (node.op === '+' || node.op === '-'))
      return polyDegree(node.operand, v);
    if (node.type === 'binop') {
      if (node.op === '+' || node.op === '-') {
        return Math.max(polyDegree(node.left, v), polyDegree(node.right, v));
      }
      if (node.op === '*' || node.op === '/') {
        const a = polyDegree(node.left, v), b = polyDegree(node.right, v);
        if (a < 0 || b < 0) return -1;
        if (node.op === '/' && b !== 0) return -1;
        return a + b;
      }
      if (node.op === '^') {
        const a = polyDegree(node.left, v);
        const b = node.right.type === 'num' ? node.right.value : -1;
        if (a < 0 || b < 0 || b !== Math.floor(b)) return -1;
        return a * b;
      }
    }
    return -1;
  }

  function evalConst(node, v) {
    if (!node) return 0;
    if (node.type === 'num') return node.value;
    if (node.type === 'var') {
      if (node.name in CONSTANTS) return CONSTANTS[node.name];
      throw new Error('not const');
    }
    if (node.type === 'unary' && (node.op === '+' || node.op === '-')) {
      return node.op === '-' ? -evalConst(node.operand, v) : evalConst(node.operand, v);
    }
    if (node.type === 'binop') {
      const a = evalConst(node.left, v);
      const b = evalConst(node.right, v);
      switch (node.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return a / b;
        case '^': return Math.pow(a, b);
      }
    }
    throw new Error('not const');
  }

  /* ============================================================
   * 异步 & 超时
   * ============================================================ */
  function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        reject(new Error((label || 'Operation') + ' timeout after ' + ms + 'ms'));
      }, ms);
      promise.then(
        function (v) { clearTimeout(timer); resolve(v); },
        function (e) { clearTimeout(timer); reject(e); }
      );
    });
  }

  /* ============================================================
   * Python 进程管理 (自动启动后端)
   *  - 仅 Node 环境有效 (浏览器环境跳过)
   *  - 幂等: 同一端口已启动则复用
   *  - 自动寻找 python / python3, 自动检测 mpmath
   * ============================================================ */
  const _pyProc = {
    proc: null,        // child_process 实例
    port: null,        // 当前端口
    url: null,         // http://127.0.0.1:port
    starting: null,    // 启动中的 Promise (并发去重)
    scriptDir: null,   // precision_server.py 所在目录
    lastUsed: 0,       // 最近一次使用时间
    autoStopTimer: null
  };

  // 仅 Node 才有这些
  const _node = {
    cp: (typeof require !== 'undefined') ? require('child_process') : null,
    fs: (typeof require !== 'undefined') ? require('fs') : null,
    path: (typeof require !== 'undefined') ? require('path') : null,
    os: (typeof require !== 'undefined') ? require('os') : null
  };
  const isNode = !!_node.cp;

  /** 寻找可用的 python 解释器 (返回 {cmd, args} 或 null) */
  function _findPython() {
    if (!isNode) return null;
    // 优先 python3 (Linux/Mac), 再 python (Windows)
    const candidates = process.platform === 'win32'
      ? ['py -3', 'python', 'python3']
      : ['python3', 'python'];
    for (const cand of candidates) {
      const parts = cand.split(/\s+/);
      const cmd = parts[0], args = parts.slice(1);
      try {
        const r = _node.cp.spawnSync(cmd, args.concat(['--version']), {
          encoding: 'utf8', timeout: 3000, windowsHide: true
        });
        if (r.status === 0 || /Python\s+\d/.test((r.stdout || '') + (r.stderr || ''))) {
          return { cmd, args };
        }
      } catch (e) { /* try next */ }
    }
    return null;
  }

  /** 检测 mpmath 是否已安装 */
  function _hasMpmath(python) {
    try {
      const r = _node.cp.spawnSync(python.cmd, python.args.concat(['-c', 'import mpmath; print(mpmath.__version__)']),
        { encoding: 'utf8', timeout: 5000, windowsHide: true });
      return r.status === 0;
    } catch (e) { return false; }
  }

  /** 寻找 precision_server.py 路径 */
  function _findServerScript() {
    if (_pyProc.scriptDir) return _pyProc.scriptDir;
    if (!isNode) return null;
    const candidates = [];
    // 1. 同目录 (mathEvaluator.js 所在)
    try {
      const self = require.resolve('./mathEvaluator.js');
      candidates.push(_node.path.dirname(self));
    } catch (e) { /* not require-able, skip */ }
    // 2. CWD
    candidates.push(process.cwd());
    // 3. __dirname 兜底
    if (typeof __dirname !== 'undefined') candidates.push(__dirname);

    for (const dir of candidates) {
      const p = _node.path.join(dir, 'precision_server.py');
      if (_node.fs.existsSync(p)) {
        _pyProc.scriptDir = dir;
        return dir;
      }
    }
    return null;
  }

  /** 轮询 /health 直到就绪 */
  async function _waitReady(url, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(url + '/health');
        if (r.ok) {
          const j = await r.json();
          if (j && j.status === 'ok') return true;
        }
      } catch (e) { /* not ready yet */ }
      await new Promise(res => setTimeout(res, 150));
    }
    return false;
  }

  /**
   * 启动 Python 高精度后端
   *  - 同一端口已启动则直接返回
   *  - 自动找 python / python3, 自动检测 mpmath
   *  - 找不到 / 检测失败抛错 (错误信息明确)
   *
   * opts = {
   *   port: 9876,                // 端口, 默认 9876
   *   host: '127.0.0.1',         // 主机
   *   script: null,              // 指定 precision_server.py 路径, 默认自动找
   *   python: null,              // 指定 python 解释器, 默认自动找
   *   precision: 50,             // 默认精度
   *   waitTimeout: 8000,         // 等待就绪超时
   *   installMpmath: false       // 若 mpmath 缺失, 是否自动 pip install
   * }
   * 返回 { url, port, proc, stop: () => Promise<void> }
   */
  async function startPythonBackend(opts) {
    opts = opts || {};
    if (!isNode) {
      throw new Error('startPythonBackend() only works in Node.js environment');
    }
    const port = opts.port || 9876;
    const host = opts.host || '127.0.0.1';
    const url = 'http://' + host + ':' + port;

    // 复用: 同一 url 已经活着就直接返回
    if (_pyProc.proc && _pyProc.url === url && !_pyProc.proc.killed) {
      _pyProc.lastUsed = Date.now();
      return { url: _pyProc.url, port: _pyProc.port, proc: _pyProc.proc, stop: stopPythonBackend };
    }

    // 并发去重: 多次同时调用只启动一次
    if (_pyProc.starting) return _pyProc.starting;

    _pyProc.starting = (async () => {
      // 1) 探测: 端口是否已被占用 (可能是用户手动启的)
      try {
        const r = await fetch(url + '/health');
        if (r.ok) {
          // 已有外部进程在跑, 直接接管
          _pyProc.url = url;
          _pyProc.port = port;
          _pyProc.proc = { killed: false, _external: true };
          _pyProc.lastUsed = Date.now();
          return { url, port, proc: _pyProc.proc, stop: stopPythonBackend, external: true };
        }
      } catch (e) { /* no server, continue */ }

      // 2) 找 Python
      const python = opts.python || _findPython();
      if (!python) {
        throw new Error('Python interpreter not found. Please install Python 3 and ensure `python` or `python3` is in PATH.');
      }

      // 3) 检测 mpmath
      if (!_hasMpmath(python)) {
        if (opts.installMpmath) {
          console.log('[mathEvaluator] mpmath not found, installing...');
          const inst = _node.cp.spawnSync(python.cmd,
            python.args.concat(['-m', 'pip', 'install', '--quiet', 'mpmath']),
            { encoding: 'utf8', timeout: 60000, windowsHide: true });
          if (inst.status !== 0) {
            throw new Error('Failed to install mpmath: ' + (inst.stderr || inst.stdout || ''));
          }
        } else {
          throw new Error('mpmath is not installed. Run: ' +
            python.cmd + (python.args.length ? ' ' + python.args.join(' ') : '') +
            ' -m pip install mpmath  (or pass { installMpmath: true })');
        }
      }

      // 4) 找服务端脚本
      let scriptDir = opts.script ? _node.path.dirname(opts.script) : _findServerScript();
      const scriptFile = opts.script
        ? _node.path.basename(opts.script)
        : 'precision_server.py';
      if (!scriptDir || !_node.fs.existsSync(_node.path.join(scriptDir, scriptFile))) {
        throw new Error('precision_server.py not found. Place it next to mathEvaluator.js or pass { script: "/abs/path/to/precision_server.py" }');
      }

      // 5) 启动子进程
      //    Python 端 sys.argv:  [script, port, host]   (precision 通过 HTTP body 传)
      const scriptPath = _node.path.join(scriptDir, scriptFile);
      const child = _node.cp.spawn(python.cmd,
        python.args.concat([scriptPath, String(port), host]),
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
      );
      child.stdout.on('data', d => process.stdout && process.stdout.write && process.stdout.write('[py] ' + d));
      child.stderr.on('data', d => process.stderr && process.stderr.write && process.stderr.write('[py!] ' + d));
      child.on('exit', (code, sig) => {
        if (_pyProc.proc === child) {
          _pyProc.proc = null;
          _pyProc.url = null;
          _pyProc.port = null;
        }
      });

      _pyProc.proc = child;
      _pyProc.port = port;
      _pyProc.url = url;
      _pyProc.lastUsed = Date.now();

      // 6) 等待就绪
      const ok = await _waitReady(url, opts.waitTimeout || 8000);
      if (!ok) {
        try { child.kill(); } catch (e) {}
        _pyProc.proc = null;
        throw new Error('Python backend failed to become ready within ' + (opts.waitTimeout || 8000) + 'ms');
      }
      return { url, port, proc: child, stop: stopPythonBackend };
    })();

    try {
      return await _pyProc.starting;
    } finally {
      _pyProc.starting = null;
    }
  }

  /** 停止 Python 后端 (仅关闭由 startPythonBackend 启动的进程) */
  async function stopPythonBackend() {
    if (_pyProc.autoStopTimer) {
      clearTimeout(_pyProc.autoStopTimer);
      _pyProc.autoStopTimer = null;
    }
    const child = _pyProc.proc;
    if (!child) return;
    if (child._external) {
      _pyProc.proc = null;
      return;
    }
    try { child.kill(); } catch (e) {}
    // 等实际退出
    await new Promise(res => {
      if (child.exitCode !== null) return res();
      const t = setTimeout(res, 1500);
      child.on('exit', () => { clearTimeout(t); res(); });
    });
    _pyProc.proc = null;
    _pyProc.url = null;
    _pyProc.port = null;
  }

  /** 自动启动包装: 内部使用 */
  async function _ensurePython(opts) {
    if (!isNode) {
      throw new Error('autoStartPython requires Node.js environment');
    }
    if (!opts || !opts.autoStartPython) return null;
    // 已有 url 就直接用
    const existing = opts.pythonUrl || config.pythonUrl;
    if (existing) return { url: existing.replace(/\/$/, ''), port: null, proc: null };
    // 启动
    const startOpts = {
      port: opts.pythonPort || config.pythonPort || 9876,
      host: opts.pythonHost || config.pythonHost || '127.0.0.1',
      precision: opts.precision || config.defaultPrecision,
      installMpmath: opts.installMpmath !== false
    };
    if (opts.pythonScript) startOpts.script = opts.pythonScript;
    if (opts.pythonCmd)    startOpts.python = opts.pythonCmd;
    const info = await startPythonBackend(startOpts);
    return info;
  }

  /* ============================================================
   * Python 高精度后端 (HTTP 调用)
   * ============================================================ */
  async function callPython(path, payload, timeoutMs) {
    if (typeof fetch === 'undefined') {
      return Promise.reject(new Error(
        'fetch is not available. Use a modern browser or Node 18+.'
      ));
    }
    // 1) autoStartPython ?
    let autoStarted = null;
    if (payload && payload.autoStartPython && !payload.pythonUrl && !config.pythonUrl) {
      autoStarted = await _ensurePython(payload);
    }
    const base = (payload.pythonUrl || (autoStarted && autoStarted.url) || config.pythonUrl || '').replace(/\/$/, '');
    if (!base) return Promise.reject(new Error('pythonUrl is not configured (set pythonUrl or pass { autoStartPython: true })'));

    // 触达后, 刷新 lastUsed
    if (autoStarted) _pyProc.lastUsed = Date.now();

    const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = setTimeout(function () { if (controller) controller.abort(); }, timeoutMs);

    const body = Object.assign({}, payload);
    delete body.pythonUrl;
    delete body.timeout;
    delete body.autoStartPython;
    delete body.pythonPort;
    delete body.pythonHost;
    delete body.pythonScript;
    delete body.pythonCmd;
    delete body.installMpmath;

    try {
      const r = await fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined
      });
      if (!r.ok) throw new Error('Python backend HTTP ' + r.status);
      const data = await r.json();
      if (data && data.error) throw new Error('Python backend: ' + data.error);
      return data.result;
    } finally { clearTimeout(timer); }
  }

  /* ============================================================
   * 对外 API
   * ============================================================ */
  function evaluate(expr, vars) {
    if (typeof expr !== 'string') throw new TypeError('expr must be a string');
    if (expr.indexOf('=') !== -1) {
      throw new Error('Expression contains "=". Use solve() for equations.');
    }
    // 防止 "sin with sin=1" 这种给内置函数/常量赋值的输入污染求值
    if (vars) {
      for (const k in vars) {
        if (Object.prototype.hasOwnProperty.call(CONSTANTS, k)) {
          throw new Error(`Cannot override constant "${k}"`);
        }
        if (Object.prototype.hasOwnProperty.call(FUNCTIONS, k)) {
          throw new Error(`Cannot override function "${k}"`);
        }
      }
    }
    const ast = parse(expr);
    const r = evaluateAst(ast, vars);
    // 极小/极大字面量: 还原成原始字符串, 不让 IEEE 754 下溢吞掉
    if (r && typeof r === 'object' && r._origStr && typeof r.valueOf === 'function') {
      return numToString(r);
    }
    return r;
  }

  function evaluateAsync(expr, vars, options) {
    options = options || {};
    const timeout = options.timeout || config.timeout;
    const usePython = !!(options.pythonUrl || config.pythonUrl || options.autoStartPython || config.pythonAutoStart);

    if (usePython) {
      return withTimeout(
        callPython('/evaluate', {
          expression: expr,
          variables: vars || {},
          precision: options.precision || config.defaultPrecision,
          pythonUrl: options.pythonUrl,
          autoStartPython: !!(options.autoStartPython || config.pythonAutoStart),
          pythonPort: options.pythonPort || config.pythonPort,
          pythonHost: options.pythonHost || config.pythonHost,
          pythonScript: options.pythonScript,
          pythonCmd: options.pythonCmd,
          installMpmath: options.installMpmath,
          timeout: timeout
        }, timeout),
        timeout,
        'evaluateAsync'
      );
    }

    return withTimeout(new Promise(function (resolve, reject) {
      try { resolve(evaluate(expr, vars)); }
      catch (e) { reject(e); }
    }), timeout, 'evaluateAsync');
  }

  function solve(expr, varName, options) {
    if (typeof expr !== 'string') throw new TypeError('expr must be a string');
    if (!varName) {
      // 自动选取第一个出现的非常量变量
      const ast = buildEquationAst(expr);
      const vars = collectVariables(ast, {});
      for (const k in vars) {
        if (!(k in CONSTANTS)) { varName = k; break; }
      }
      if (!varName) throw new Error('No variable found in expression');
    } else {
      // 显式指定 varName 时也要校验, 防止 "pi+1=2 for pi" 这种把常量当变量
      if (Object.prototype.hasOwnProperty.call(CONSTANTS, varName)) {
        throw new Error(`Cannot solve for constant "${varName}"`);
      }
      if (Object.prototype.hasOwnProperty.call(FUNCTIONS, varName)) {
        throw new Error(`Cannot solve for function "${varName}"`);
      }
    }
    const ast = buildEquationAst(expr);
    return solveAst(ast, varName, options);
  }

  function solveAsync(expr, varName, options) {
    options = options || {};
    const timeout = options.timeout || config.timeout;
    const usePython = !!(options.pythonUrl || config.pythonUrl || options.autoStartPython || config.pythonAutoStart);

    if (usePython) {
      // Python 后端: 直接返回高精度字符串数组, 不再被 parseFloat 截断
      return withTimeout(
        callPython('/solve', {
          expression: expr,
          variable: varName,
          options: {
            start: options.start != null ? options.start : config.sampleDomain[0],
            end:   options.end   != null ? options.end   : config.sampleDomain[1],
            samples: options.samples != null ? options.samples : config.sampleCount,
            epsilon: String(options.epsilon != null ? options.epsilon : config.epsilon),
            precision: options.precision || config.defaultPrecision,
            variables: options.vars || {}
          },
          pythonUrl: options.pythonUrl,
          autoStartPython: !!(options.autoStartPython || config.pythonAutoStart),
          pythonPort: options.pythonPort || config.pythonPort,
          pythonHost: options.pythonHost || config.pythonHost,
          pythonScript: options.pythonScript,
          pythonCmd: options.pythonCmd,
          installMpmath: options.installMpmath,
          timeout: timeout
        }, timeout),
        timeout,
        'solveAsync'
      );
    }

    return withTimeout(new Promise(function (resolve, reject) {
      try { resolve(solve(expr, varName, options)); }
      catch (e) { reject(e); }
    }), timeout, 'solveAsync');
  }

  // limit(expr, varName, point)
  // expr:    字符串
  // varName: 字符串
  // point:   字符串/数字  ->  内部用 String(point) 转发给 Python,  支持 "inf"/"-inf"/"nan"
  function limitAsync(expr, varName, point, options) {
    if (typeof expr !== 'string') throw new TypeError('expr must be a string');
    if (typeof varName !== 'string' || !varName) throw new TypeError('varName must be a non-empty string');
    options = options || {};
    const timeout = options.timeout || config.timeout;
    const usePython = !!(options.pythonUrl || config.pythonUrl || options.autoStartPython || config.pythonAutoStart);

    if (usePython) {
      // Python 后端: 走 mpmath.limit, 任意精度
      return withTimeout(
        callPython('/limit', {
          expression: expr,
          variable: varName,
          point: String(point),
          precision: options.precision || config.defaultPrecision,
          pythonUrl: options.pythonUrl,
          autoStartPython: !!(options.autoStartPython || config.pythonAutoStart),
          pythonPort: options.pythonPort || config.pythonPort,
          pythonHost: options.pythonHost || config.pythonHost,
          pythonScript: options.pythonScript,
          pythonCmd: options.pythonCmd,
          installMpmath: options.installMpmath,
          timeout: timeout
        }, timeout),
        timeout,
        'limitAsync'
      );
    }

    // 纯 JS 路径: 走 evaluate('limit(expr, var, point)'), 让 _evalLimit 处理
    return withTimeout(new Promise(function (resolve, reject) {
      try {
        resolve(evaluate('limit(' + expr + ',' + varName + ',' + String(point) + ')'));
      } catch (e) { reject(e); }
    }), timeout, 'limitAsync');
  }

  function registerFunction(name, fn /*, arity? */) {
    if (typeof name !== 'string') throw new TypeError('name must be a string');
    if (typeof fn !== 'function') throw new TypeError('fn must be a function');
    FUNCTIONS[name] = fn;
  }

  function registerConstant(name, value) {
    if (typeof name !== 'string') throw new TypeError('name must be a string');
    CONSTANTS[name] = value;
  }

  return {
    // 核心
    evaluate: evaluate,
    evaluateAsync: evaluateAsync,
    solve: solve,
    solveAsync: solveAsync,
    limitAsync: limitAsync,
    // 扩展
    registerFunction: registerFunction,
    registerConstant: registerConstant,
    setConfig: setConfig,
    // Python 后端生命周期 (Node 环境)
    startPythonBackend: startPythonBackend,
    stopPythonBackend: stopPythonBackend,
    isPythonBackendRunning: function () { return !!(_pyProc.proc && !_pyProc.proc.killed); },
    // 内部 (便于单测/调试)
    _internals: {
      tokenize: tokenize,
      parse: parse,
      evaluateAst: evaluateAst,
      buildEquationAst: buildEquationAst,
      solveAst: solveAst,
      collectVariables: collectVariables,
      config: config,
      FUNCTIONS: FUNCTIONS,
      CONSTANTS: CONSTANTS
    }
  };
}));
