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
            // ★ 修复: 必须确认 e 后面是 [+-]?数字 才是合法科学计数法
            //   之前 3e^x 会被吞成 num "3e" (parseFloat 静默返回 3), 留下 ^x 变成 3^x,
            //   再叠加隐式乘得到 x^(3^x) 错误结果; 正确语义应是 x^3 * e^x
            let k = j + 1;
            if (input[k] === '+' || input[k] === '-') k++;
            if (input[k] >= '0' && input[k] <= '9') {
              hasE = true;
              j = k;  // 跳到数字开始
            } else {
              break;  // e 不是数字一部分, 留给 ident tokenizer
            }
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
        const fullIdent = input.substring(i, j);
        // ★ 智能拆分:  xcos(...)  /  xsin(...)  /  2xcos(...)  等
        //   若 identifier 以一个已知函数名结尾, 且后面跟 ( , 拆成 var * func
        //   例: xcos( -> x * cos( ,  2xcos -> 2 * x * cos
        //   仅在 identifier 长度 > 函数名长度 (即有 var 前缀) 时才拆
        //   ★ r8: 但 fullIdent 本身是已知函数 (如 asinh, acosh, atanh) 时, 整体不拆
        if (j < len && input[j] === '('
            && (Object.prototype.hasOwnProperty.call(FUNCTIONS, fullIdent)
                || fullIdent === 'sum' || fullIdent === 'product' || fullIdent === 'diff'
                || fullIdent === 'integrate' || fullIdent === 'limit'
                || fullIdent === 'symbolicDiff' || fullIdent === 'symbolicIntegrate')) {
          // 整个 identifier 是已知函数, 不切
          tokens.push({ type: 'ident', value: fullIdent });
          i = j;
          continue;
        }
        let splitDone = false;
        if (j < len && input[j] === '(') {
          for (let k = 1; k < fullIdent.length; k++) {
            const suffix = fullIdent.substring(k);
            if (Object.prototype.hasOwnProperty.call(FUNCTIONS, suffix)
                || suffix === 'sum' || suffix === 'product' || suffix === 'diff'
                || suffix === 'integrate' || suffix === 'limit'
                || suffix === 'symbolicDiff' || suffix === 'symbolicIntegrate') {
              tokens.push({ type: 'ident', value: fullIdent.substring(0, k) });
              tokens.push({ type: 'op', value: '*' });
              tokens.push({ type: 'ident', value: suffix });
              splitDone = true;
              break;
            }
          }
        }
        if (!splitDone) {
          tokens.push({ type: 'ident', value: fullIdent });
        }
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
      || name === 'integrate' || name === 'limit'
      || name === 'symbolicDiff' || name === 'symbolicIntegrate';
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
      // 整数指数走精确连乘路径, 避免 exp(b*ln(a)) 的浮点误差
      if (o instanceof C && o.im === 0 && Number.isInteger(o.re)) {
        const base = (this instanceof C) ? this : new C(this, 0);
        const n = o.re;
        if (n === 0) return new C(1, 0);
        let result;
        if (n > 0) {
          result = new C(1, 0);
          for (let k = 0; k < n; k++) result = result.mul(base);
        } else {
          const inv = new C(1, 0).div(base);
          result = new C(1, 0);
          for (let k = 0; k < -n; k++) result = result.mul(inv);
        }
        return new C(result.re, result.im);
      }
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
    // 反双曲 (real 域)
    asinh: (x) => {
      if (x instanceof Complex) return x.add(new Complex(1, 0).add(x.mul(x)).sqrt()).ln();
      return Math.asinh(x);
    },
    acosh: (x) => {
      if (x instanceof Complex) return x.add(x.mul(x).sub(new Complex(1, 0)).sqrt()).ln();
      if (typeof x === 'number' && x >= 1) return Math.acosh(x);
      // x < 1: 走复数
      const cx = (typeof x === 'number') ? new Complex(x, 0) : x;
      return cx.add(cx.mul(cx).sub(new Complex(1, 0)).sqrt()).ln();
    },
    atanh: (x) => {
      if (x instanceof Complex) {
        return new Complex(0.5, 0).mul(
          new Complex(1, 0).add(x).ln().sub(new Complex(1, 0).sub(x).ln())
        );
      }
      if (typeof x === 'number' && x > -1 && x < 1) return Math.atanh(x);
      // |x| >= 1: 走复数
      const cx = (typeof x === 'number') ? new Complex(x, 0) : x;
      return new Complex(0.5, 0).mul(
        new Complex(1, 0).add(cx).div(new Complex(1, 0).sub(cx)).ln()
      );
    },
    // r15: erf = 2/sqrt(pi) * ∫_0^x exp(-t^2) dt
    //   实数域: 直接 Math.erf (Node 22+ 支持, 老版本用近似)
    //   复数域: 抛错让 Python 后端处理
    _erfApprox: (x) => {
      // Abramowitz & Stegun 7.1.26, 误差 < 1.5e-7
      const a1 =  0.254829592, a2 = -0.284496736, a3 =  1.421413741;
      const a4 = -1.453152027, a5 =  1.061405429, p  =  0.3275911;
      const sign = x < 0 ? -1 : 1;
      const ax = Math.abs(x);
      const t = 1.0 / (1.0 + p * ax);
      const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
      return sign * y;
    },
    erf: (x) => {
      if (x instanceof Complex) {
        throw new Error('erf() complex argument requires Python backend');
      }
      if (typeof x === 'number') {
        if (typeof Math.erf === 'function') return Math.erf(x);
        return this._erfApprox(x);
      }
      throw new Error('erf() unsupported argument type: ' + typeof x);
    },
    erfc: (x) => {
      if (x instanceof Complex) throw new Error('erfc() complex argument requires Python backend');
      if (typeof x !== 'number') throw new Error('erfc() unsupported argument type');
      if (typeof Math.erf === 'function') return Math.erfc(x);
      return 1 - (this && this._erfApprox ? this._erfApprox(x) :
        (function() {
          const a1 =  0.254829592, a2 = -0.284496736, a3 =  1.421413741;
          const a4 = -1.453152027, a5 =  1.061405429, p  =  0.3275911;
          const sign = x < 0 ? -1 : 1;
          const ax = Math.abs(x);
          const t = 1.0 / (1.0 + p * ax);
          const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
          return sign * y;
        })());
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
    },
    // ★ r5: 二项式系数 C(n, k) = n! / (k! * (n-k)!)
    binom: function (n, k) {
      n = Number(n); k = Number(k);
      if (!Number.isInteger(n) || !Number.isInteger(k)) throw new Error('binom() requires integer arguments');
      if (k < 0 || k > n) return 0;
      if (k > n - k) k = n - k;  // 用较小的 k 算, 减少乘法
      let r = 1;
      for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1);
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
    // ★ 用相对 + 绝对混合容差, 避免 f 值很小时 (如 ∫_0^1e-6 t³ dt ≈ 1e-25)
    //   因 tol=1e-12 太大直接返回 0
    const relErr = Math.abs(S12 - S) * (1 / Math.max(1e-30, Math.abs(S12)));
    if (depth <= 0 || Math.abs(S12 - S) < 15 * tol || relErr < 1e-12) {
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
    const fromAst = args[1], toAst = args[2], exprAst = args[3];

    // ★ 自由变量上界检测:  evaluateAst 抛 "Unknown variable" 时, 走 symbolicSum
    //   错误格式: __SUM_SYMBOUND__:<var>:<encodedFrom>:<encodedTo>:<encodedBody>
    //   bot 端 catch 后调 M.symbolicSum(var, from, to, body)
    let fromRaw, toRaw;
    try {
      fromRaw = evaluateAst(fromAst, baseVars);
      toRaw   = evaluateAst(toAst,   baseVars);
    } catch (e) {
      if (e && e.message && e.message.indexOf('Unknown variable') === 0) {
        const fromStr = _astToString(fromAst);
        const toStr   = _astToString(toAst);
        const bodyStr = _astToString(exprAst);
        throw new Error('__SUM_SYMBOUND__:' + varName + ':' +
          encodeURIComponent(fromStr) + ':' +
          encodeURIComponent(toStr)   + ':' +
          encodeURIComponent(bodyStr));
      }
      throw e;
    }

    // ★ 上界是无穷 (Infinity / -Infinity) -> 抛特殊错误, 让 bot 调 nsumAsync (走 Python mpmath.nsum)
    //   错误格式: __NSUM_INF__:<varName>:<from>:<encodedBody>
    //   bot 端 catch 后解析, 调 M.nsumAsync(varName, from, body, {autoStartPython: true})
    //   ★ r15-amend9 Bug 4.1: 扩展 Infinity 检查含 fromRaw (之前 fromRaw=-Infinity 走到 _toBigIntRange 抛错).
    //     fromRaw 是 ±Infinity 时用 _normalizeInfBound 传 'inf'/'-inf' 字符串, bot 透传给 nsumAsync.
    if (toRaw === Infinity || toRaw === -Infinity || fromRaw === Infinity || fromRaw === -Infinity) {
      const fromField = (fromRaw === Infinity || fromRaw === -Infinity)
        ? _normalizeInfBound(fromRaw)
        : String(_toBigIntRange(fromRaw, 'sum 下界'));
      const bodyStr = _astToString(exprAst);
      throw new Error('__NSUM_INF__:' + varName + ':' + fromField + ':' + encodeURIComponent(bodyStr));
    }
    // 上界是非整数浮点 -> 也走 symbolic
    if (typeof toRaw === 'number' && !Number.isInteger(toRaw)) {
      const fromStr = _astToString(fromAst);
      const toStr   = _astToString(toAst);
      const bodyStr = _astToString(exprAst);
      throw new Error('__SUM_SYMBOUND__:' + varName + ':' +
        encodeURIComponent(fromStr) + ':' +
        encodeURIComponent(toStr)   + ':' +
        encodeURIComponent(bodyStr));
    }

    const fromI = _toBigIntRange(fromRaw, 'sum 下界');
    const toI   = _toBigIntRange(toRaw, 'sum 上界');
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
    const fromAst = args[1], toAst = args[2], exprAst = args[3];

    // ★ 自由变量上界检测:  evaluateAst 抛 "Unknown variable" 时, 走 symbolicProduct
    //   错误格式: __PRODUCT_SYMBOUND__:<var>:<encodedFrom>:<encodedTo>:<encodedBody>
    //   bot 端 catch 后调 M.symbolicProduct(var, from, to, body)
    let fromRaw, toRaw;
    try {
      fromRaw = evaluateAst(fromAst, baseVars);
      toRaw   = evaluateAst(toAst,   baseVars);
    } catch (e) {
      if (e && e.message && e.message.indexOf('Unknown variable') === 0) {
        const fromStr = _astToString(fromAst);
        const toStr   = _astToString(toAst);
        const bodyStr = _astToString(exprAst);
        throw new Error('__PRODUCT_SYMBOUND__:' + varName + ':' +
          encodeURIComponent(fromStr) + ':' +
          encodeURIComponent(toStr)   + ':' +
          encodeURIComponent(bodyStr));
      }
      throw e;
    }
    // 上界是无穷 -> 抛特殊错误, 让 bot 调 nprodAsync (走 Python mpmath.nprod)
    //   r15: 之前这里抛 __PRODUCT_SYMBOUND__ 让 bot 走 symbolicProduct, 但 symbolicProduct
    //   不能给具体数值 (e.g. ∏(1-1/n^2) = sinh(π)/π ≈ 3.676). 改用数值路径
    //   错误格式: __NPROD_INF__:<var>:<from>:<encodedBody>
    //   ★ r15-amend9 Bug 4.1: 扩展 Infinity 检查含 fromRaw (同 _evalSum).
    if (toRaw === Infinity || toRaw === -Infinity || fromRaw === Infinity || fromRaw === -Infinity) {
      const fromField = (fromRaw === Infinity || fromRaw === -Infinity)
        ? _normalizeInfBound(fromRaw)
        : String(_toBigIntRange(fromRaw, 'product 下界'));
      const bodyStr = _astToString(exprAst);
      throw new Error('__NPROD_INF__:' + varName + ':' + fromField + ':' + encodeURIComponent(bodyStr));
    }
    // 上界是非整数浮点 -> 走 symbolic
    if (typeof toRaw === 'number' && !Number.isInteger(toRaw)) {
      const fromStr = _astToString(fromAst);
      const toStr   = _astToString(toAst);
      const bodyStr = _astToString(exprAst);
      throw new Error('__PRODUCT_SYMBOUND__:' + varName + ':' +
        encodeURIComponent(fromStr) + ':' +
        encodeURIComponent(toStr)   + ':' +
        encodeURIComponent(bodyStr));
    }

    const fromI = _toBigIntRange(fromRaw, 'product 下界');
    const toI   = _toBigIntRange(toRaw,   'product 上界');
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

    // r15: 嵌套 diff (e.g. d^10 f) 用数值有限差分会灾难性累积误差.
    //   改为递归 flatten + symbolicDiff: 若 exprAst 是 diff(...), 把整条 diff 链合并成
    //   "对 baseExpr 做 N 阶 symbolicDiff", 然后 evaluate at x0.
    let baseAst = exprAst;
    let order = 1;
    while (baseAst && baseAst.type === 'func' && baseAst.name === 'diff'
           && baseAst.args.length === 2
           && baseAst.args[1].type === 'var' && baseAst.args[1].name === varName) {
      baseAst = baseAst.args[0];
      order += 1;
    }
    // 简化: 现在 baseAst 是最里层 (不再是 diff), order 是总阶数
    const baseStr = _astToString(baseAst);
    let derivStr;
    try {
      derivStr = baseStr;
      for (let k = 0; k < order; k++) {
        derivStr = symbolicDiff(derivStr, varName);
      }
    } catch (e) {
      derivStr = null;
    }
    if (derivStr !== null) {
      try {
        const v2 = Object.assign({}, baseVars);
        v2[varName] = x0;
        return evaluate(derivStr, v2);
      } catch (e) {
        // 回退
      }
    }

    // 数值 fallback
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

  /* ============================================================
   * 符号求导:  对 AST 求导, 返回新的 AST (再做 simplify + toString)
   *   - 支持:  + - * / ^ 常数  变量  sin cos tan asin acos atan
   *            sinh cosh tanh  exp ln log log10 sqrt
   *   - 不支持:  abs (不光滑)  ! (阶乘, 不连续)
   *   - 幂函数:  u^v 区分 u 或 v 是否依赖 x
   *   - 简化:  0+x=x, 1*x=x, x^0=1, x^1=x, 0/x=0 等
   * ============================================================ */
  function _dependsOn(ast, varName) {
    if (!ast) return false;
    switch (ast.type) {
      case 'num': return false;
      case 'var': return ast.name === varName;
      case 'unary': return _dependsOn(ast.operand, varName);
      case 'binop': return _dependsOn(ast.left, varName) || _dependsOn(ast.right, varName);
      case 'func':  return ast.args.some(a => _dependsOn(a, varName));
    }
    return false;
  }

  // 数值字面量: 支持 bigint, 0, 1
  function _isZeroNum(n) { return (typeof n === 'number' && n === 0) || (typeof n === 'bigint' && n === 0n); }
  function _isOneNum(n)  { return (typeof n === 'number' && n === 1)  || (typeof n === 'bigint' && n === 1n); }

  function _isZeroNode(ast) { return ast && ast.type === 'num' && _isZeroNum(ast.value); }
  function _isOneNode(ast)  { return ast && ast.type === 'num' && _isOneNum(ast.value); }
  function _isConstNum(ast) { return ast && ast.type === 'num' && (typeof ast.value === 'number' || typeof ast.value === 'bigint'); }
  // ★ 提取 AST 中的常数数值 (支持 unary -, num/bigint). 不能转时返回 null
  function _toConstNumber(ast) {
    if (!ast) return null;
    if (ast.type === 'num') {
      if (typeof ast.value === 'bigint') return Number(ast.value);
      if (typeof ast.value === 'number') return ast.value;
      return null;
    }
    if (ast.type === 'unary' && ast.op === '-') {
      const v = _toConstNumber(ast.operand);
      return v === null ? null : -v;
    }
    if (ast.type === 'unary' && ast.op === '+') {
      return _toConstNumber(ast.operand);
    }
    return null;
  }
  // ★ 检测 arg 是否是 k*x 形式 (k 为不依赖 varName 的表达式, 可以是常数也可是自由变量)
  //   返回 {k, kAst} 或 null. k=0 表示不依赖 x (常数). k=1 表示 k=1.
  //   k=NaN 表示 k 是自由变量/任意表达式 (需要符号化处理)
  //   例: 2x   -> {k:2,    kAst: num(2)}
  //        x   -> {k:1,    kAst: num(1)}
  //        x*2 -> {k:2,    kAst: num(2)}   (commutative)
  //        c   -> {k:0,    kAst: null}     (常数, 不依赖 x)
  //        kx  -> {k:NaN,  kAst: var(k)}   (k 是自由变量)
  //        k*x -> {k:NaN,  kAst: var(k)}
  function _extractLinearK(arg, varName) {
    if (!arg) return null;
    if (arg.type === 'var') {
      if (arg.name === varName) return { k: 1, kAst: _newNum(1) };
      return { k: 0, kAst: null };   // 其它变量当常数
    }
    if (!_dependsOn(arg, varName)) return { k: 0, kAst: null };
    // k*x 或 x*k 形式 (k 不依赖 varName)
    if (arg.type === 'binop' && arg.op === '*') {
      if (arg.left.type === 'var' && arg.left.name === varName && !_dependsOn(arg.right, varName)) {
        const k = _toConstNumber(arg.right);
        return { k: k === null ? NaN : k, kAst: arg.right };
      }
      if (arg.right.type === 'var' && arg.right.name === varName && !_dependsOn(arg.left, varName)) {
        const k = _toConstNumber(arg.left);
        return { k: k === null ? NaN : k, kAst: arg.left };
      }
    }
    return null;
  }

  // ★ r8: 把 expr 解析为 a*x^2 + b 形式, 返回 { a, b } 或 null
  //   其中 a, b 都是常数 (a, b 是 number, 可正可负, 也可零)
  //   例: x^2 + 1   -> { a: 1, b: 1 }
  //       1 + x^2   -> { a: 1, b: 1 }  (commutative)
  //       2*x^2 + 4 -> { a: 2, b: 4 }
  //       4 - x^2   -> { a: -1, b: 4 }
  //       x^2 - 4   -> { a: 1, b: -4 }
  //       3*x^2     -> { a: 3, b: 0 }
  //       5         -> { a: 0, b: 5 }
  function _coeffsAxx2PlusB(expr, varName) {
    if (!expr) return null;
    // 叶子: 不依赖 varName
    if (!_dependsOn(expr, varName)) {
      const v = _toConstNumber(expr);
      if (v === null) return null;
      return { a: 0, b: v };
    }
    // 叶子: k*x^2  (k 是常数)
    if (expr.type === 'binop' && expr.op === '^'
        && expr.left.type === 'var' && expr.left.name === varName
        && _isConstNum(expr.right) && Number(expr.right.value) === 2) {
      return { a: 1, b: 0 };
    }
    // k * x^2  或  x^2 * k
    if (expr.type === 'binop' && expr.op === '*') {
      // x^2 * k
      if (expr.left.type === 'binop' && expr.left.op === '^'
          && expr.left.left.type === 'var' && expr.left.left.name === varName
          && _isConstNum(expr.left.right) && Number(expr.left.right.value) === 2
          && !_dependsOn(expr.right, varName)) {
        const k = _toConstNumber(expr.right);
        if (k === null) return null;
        return { a: k, b: 0 };
      }
      // k * x^2
      if (expr.right.type === 'binop' && expr.right.op === '^'
          && expr.right.left.type === 'var' && expr.right.left.name === varName
          && _isConstNum(expr.right.right) && Number(expr.right.right.value) === 2
          && !_dependsOn(expr.left, varName)) {
        const k = _toConstNumber(expr.left);
        if (k === null) return null;
        return { a: k, b: 0 };
      }
      return null;
    }
    // +/- 两个非 x^2 项相加
    if (expr.type === 'binop' && (expr.op === '+' || expr.op === '-')) {
      let left, right;
      if (expr.op === '-') {
        // a - b:  left=a, right=b; 等价 a + (-b)
        const lb = _coeffsAxx2PlusB(expr.left, varName);
        if (lb === null) return null;
        const rb = _coeffsAxx2PlusB(expr.right, varName);
        if (rb === null) return null;
        return { a: lb.a - rb.a, b: lb.b - rb.b };
      }
      // +
      const lb = _coeffsAxx2PlusB(expr.left, varName);
      if (lb === null) return null;
      const rb = _coeffsAxx2PlusB(expr.right, varName);
      if (rb === null) return null;
      return { a: lb.a + rb.a, b: lb.b + rb.b };
    }
    return null;
  }

  function _newNum(n) { return { type: 'num', value: n }; }
  function _newVar(name) { return { type: 'var', name }; }
  function _newBinop(op, l, r) { return { type: 'binop', op, left: l, right: r }; }
  function _newUnary(op, e) { return { type: 'unary', op, operand: e }; }
  function _newFunc(name, args) { return { type: 'func', name, args }; }

  // r15-amend-simplify-cancellation: 结构相等 AST 比较
  //   用途: _simplifyAst 化简时检测同类项相消 (e.g. x - x = 0, sin(x) - sin(x) = 0)
  //   注意: 不做符号化归一 (e.g. x+y 与 y+x 不算相等, 由 + 的 commutative reorder 负责)
  //   也比较 num 的 value (含 0/1/整数/小数)
  function _astEqual(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.type !== b.type) return false;
    if (a.type === 'num') {
      // 0/1 等 const 与 unary - 形式已在外层处理, 这里只比较 raw num value
      return a.value === b.value;
    }
    if (a.type === 'var') {
      return a.name === b.name;
    }
    if (a.type === 'binop') {
      return a.op === b.op && _astEqual(a.left, b.left) && _astEqual(a.right, b.right);
    }
    if (a.type === 'unary') {
      return a.op === b.op && _astEqual(a.operand, b.operand);
    }
    if (a.type === 'func') {
      if (a.name !== b.name) return false;
      if (!a.args || !b.args) return a.args === b.args;
      if (a.args.length !== b.args.length) return false;
      for (let i = 0; i < a.args.length; i++) {
        if (!_astEqual(a.args[i], b.args[i])) return false;
      }
      return true;
    }
    return false;
  }

  // r15-amend-simplify-cancellation: 互为相反数 (a + (-a) 形式)
  //   用于 _simplifyAst 处理 binop '+' 合并项时, 检测互消的两项
  //   返回 { aPositive: AST, aNegative: AST } 或 null
  function _astNegPair(t1, t2) {
    // t1 是 unary -, t2 是正项: t1.operand vs t2 相等
    if (t1.ast.type === 'unary' && t1.ast.op === '-') {
      if (_astEqual(t1.ast.operand, t2.ast)) {
        return { aPositive: t2.ast, aNegative: t1.ast.operand };
      }
    }
    // t2 是 unary -, t1 是正项
    if (t2.ast.type === 'unary' && t2.ast.op === '-') {
      if (_astEqual(t1.ast, t2.ast.operand)) {
        return { aPositive: t1.ast, aNegative: t2.ast.operand };
      }
    }
    return null;
  }

  // 替换变量: 把 AST 中所有名为 oldVarName 的 var 节点替换为 newExpr (AST 节点)
  //   用于 Leibniz 规则: ∫_lo^hi f(t) dt 对 x 求导 -> f(hi) * hi' - f(lo) * lo'
  function _substituteVar(ast, oldVarName, newExpr) {
    if (!ast) return ast;
    switch (ast.type) {
      case 'num': return ast;
      case 'var':  return ast.name === oldVarName ? newExpr : ast;
      case 'unary': return _newUnary(ast.op, _substituteVar(ast.operand, oldVarName, newExpr));
      case 'binop': return _newBinop(ast.op,
        _substituteVar(ast.left,  oldVarName, newExpr),
        _substituteVar(ast.right, oldVarName, newExpr));
      case 'func':  return _newFunc(ast.name, ast.args.map(a => _substituteVar(a, oldVarName, newExpr)));
    }
    return ast;
  }

  // 重命名 AST 中嵌套的 sum/product/integrate/limit 的 dummy (如果名字与 outerDummy 冲突)
  //   例: outer = k, body = k*x^k + product(k,1,2,(x+k))
  //     -> product 的 dummy 改名为 _k_0, 后续 _substituteVar(body, k, 1) 不会破坏 product
  //   例: 嵌套 + 内层 dummy 名字 = outerDummy, 才改名; 否则保留
  function _renameNestedDummies(ast, outerDummy) {
    if (!ast) return ast;
    const counter = { n: 0 };
    function freshName() {
      // 用下划线前缀避免与常规变量冲突
      let name;
      do { name = '_k_' + (counter.n++); } while (_nameUsedIn(ast, name));
      return name;
    }
    function walk(node) {
      if (!node) return node;
      if (node.type === 'func' && (node.name === 'sum' || node.name === 'product'
          || node.name === 'integrate' || node.name === 'limit') && node.args.length >= 2) {
        // 第一个/第二个 arg 是 dummy (sum/product 第 0, integrate/limit 第 1)
        const dummyIdx = (node.name === 'sum' || node.name === 'product') ? 0 : 1;
        const dummyArg = node.args[dummyIdx];
        let newDummy = dummyArg;
        if (dummyArg && dummyArg.type === 'var' && dummyArg.name === outerDummy) {
          const newName = freshName();
          newDummy = { type: 'var', name: newName };
          // 替换本函数 body 中该 dummy 的所有引用
          const newArgs = node.args.slice();
          for (let i = 0; i < newArgs.length; i++) {
            if (i === dummyIdx) newArgs[i] = newDummy;
            else newArgs[i] = _substituteVar(newArgs[i], outerDummy, newDummy);
          }
          // 递归处理内部 (可能还有更内层同 dummy 冲突)
          for (let i = 0; i < newArgs.length; i++) newArgs[i] = walk(newArgs[i]);
          return { type: 'func', name: node.name, args: newArgs };
        }
        // dummy 不冲突, 递归处理内部
        const newArgs = node.args.map(a => walk(a));
        return { type: 'func', name: node.name, args: newArgs };
      }
      if (node.type === 'binop') {
        return _newBinop(node.op, walk(node.left), walk(node.right));
      }
      if (node.type === 'unary') {
        return _newUnary(node.op, walk(node.operand));
      }
      if (node.type === 'func') {
        return _newFunc(node.name, node.args.map(walk));
      }
      return node;
    }
    return walk(ast);
  }

  // 检查 var 名是否在 AST 中某处使用 (作为 var 节点, 不包括 func/dummy arg 位置)
  function _nameUsedIn(ast, name) {
    if (!ast) return false;
    if (ast.type === 'var') return ast.name === name;
    if (ast.type === 'binop') return _nameUsedIn(ast.left, name) || _nameUsedIn(ast.right, name);
    if (ast.type === 'unary') return _nameUsedIn(ast.operand, name);
    if (ast.type === 'func') {
      for (const a of ast.args) if (_nameUsedIn(a, name)) return true;
      return false;
    }
    return false;
  }

  // 展开常量范围 sum: sum(k, lo, hi, body) -> body(k=lo) + body(k=lo+1) + ... + body(k=hi)
  //   限制:  lo/hi 必须是整数常量, 范围长度 < 50 (避免爆炸)
  //   递归展开嵌套 sum/子表达式
  function _expandConstSum(ast) {
    if (!ast) return ast;
    if (ast.type === 'func' && ast.name === 'sum' && ast.args.length === 4) {
      const k    = ast.args[0];
      const lo   = ast.args[1];
      const hi   = ast.args[2];
      const body = ast.args[3];
      if (lo.type === 'num' && hi.type === 'num' && Number.isInteger(lo.value) && Number.isInteger(hi.value)) {
        const n = Math.abs(hi.value - lo.value) + 1;
        if (n <= 50) {
          const loI = Math.min(lo.value, hi.value);
          const hiI = Math.max(lo.value, hi.value);
          // ★ 重命名 body 内嵌套 sum/product/integrate/limit 的 dummy, 避免和外层 k 冲突
          //   例: body = k*x^k + product(k,1,2,(x+k)) 时, 内 product 的 k 是它自己的 dummy
          //   直接 _substituteVar(body, k, 1) 会把内 product 的 dummy 也改成 1, 破坏 product.
          const safeBody = _renameNestedDummies(body, k.name);
          let result = null;
          for (let i = loI; i <= hiI; i++) {
            const term = _substituteVar(safeBody, k.name, _newNum(i));
            result = result ? _newBinop('+', result, term) : term;
          }
          return _expandConstSum(result || _newNum(0));
        }
      }
      // lo/hi 不是 const 或范围太大: 保留 sum, 但递归展开内部
      return _newFunc('sum', ast.args.map(_expandConstSum));
    }
    if (ast.type === 'binop') {
      return _newBinop(ast.op, _expandConstSum(ast.left), _expandConstSum(ast.right));
    }
    if (ast.type === 'unary') {
      return _newUnary(ast.op, _expandConstSum(ast.operand));
    }
    if (ast.type === 'func') {
      return _newFunc(ast.name, ast.args.map(_expandConstSum));
    }
    return ast;
  }

  // 伯努利数 (前 13 个, 够常见 sum 用了)
  //   B_0=1, B_1=-1/2, B_2=1/6, B_3=0, B_4=-1/30, B_5=0, B_6=1/42, ...
  const _BERNOULLI_NUMS = [1, -1/2, 1/6, 0, -1/30, 0, 1/42, 0, -1/30, 0, 5/66, 0, -691/2730];

  // 组合数 C(n, k)
  function _comb(n, k) {
    if (k < 0 || k > n) return 0;
    if (k === 0 || k === n) return 1;
    if (k > n - k) k = n - k;
    let r = 1;
    for (let i = 0; i < k; i++) {
      r = r * (n - i) / (i + 1);
    }
    return r;
  }

  // 伯努利多项式 B_n(x) 的 AST
  //   B_n(x) = sum_{j=0}^{n} C(n,j) * B_j * x^{n-j}
  //   例: B_0(x)=1,  B_1(x)=x-1/2,  B_2(x)=x^2-x+1/6
  function _bernoulliPoly(n, xAst) {
    if (n < 0) return _newNum(0);
    if (n > 12) throw new Error('Bernoulli poly degree too high: ' + n);
    let result = null;
    for (let j = 0; j <= n; j++) {
      const B = _BERNOULLI_NUMS[j];
      if (B === 0) continue;
      const coeff = B * _comb(n, j);
      const power = n - j;
      let term;
      if (power === 0) {
        term = _newNum(coeff);
      } else if (power === 1) {
        term = (coeff === 1) ? xAst : _newBinop('*', _newNum(coeff), xAst);
      } else {
        const xPow = _newBinop('^', xAst, _newNum(power));
        term = (coeff === 1) ? xPow : _newBinop('*', _newNum(coeff), xPow);
      }
      result = result ? _newBinop('+', result, term) : term;
    }
    return result || _newNum(0);
  }

  // 把 body 分解为关于 k 的多项式, 返回 { "n": coeff }  (n 为次数, coeff 可以是 number 或 AST)
  //   例: body=k      -> {1: 1}
  //        body=3*k^2  -> {2: 3}
  //        body=k*x+1  -> {1: xAst, 0: 1}  (x 视为常数)
  //   如果 body 不是 k 的多项式 (含 sin(k), 2^k, k^x 等), 返回 null
  function _decomposePolyInK(ast, kName) {
    if (!ast) return { 0: 0 };
    switch (ast.type) {
      case 'num':
        return { 0: Number(ast.value) };
      case 'var':
        if (ast.name === kName) return { 1: 1 };
        // 其他变量视为常数 (其 AST 整体作为系数)
        return { 0: ast };
      case 'unary':
        if (ast.op === '-') {
          const sub = _decomposePolyInK(ast.operand, kName);
          if (sub === null) return null;
          const result = {};
          for (const n in sub) {
            const v = sub[n];
            result[n] = (typeof v === 'number') ? -v : _newUnary('-', v);
          }
          return result;
        }
        if (ast.op === '+') return _decomposePolyInK(ast.operand, kName);
        return null;
      case 'binop': {
        if (ast.op === '+' || ast.op === '-') {
          const left = _decomposePolyInK(ast.left, kName);
          const right = _decomposePolyInK(ast.right, kName);
          if (left === null || right === null) return null;
          const result = Object.assign({}, left);
          for (const n in right) {
            const a = result[n] !== undefined ? result[n] : 0;
            const b = right[n];
            if (ast.op === '+') {
              result[n] = _polyAdd(a, b);
            } else {
              result[n] = _polySub(a, b);
            }
          }
          return result;
        }
        if (ast.op === '*') {
          const left = _decomposePolyInK(ast.left, kName);
          const right = _decomposePolyInK(ast.right, kName);
          if (left === null || right === null) return null;
          // convolution:  (c1 x^a) * (c2 x^b) = (c1*c2) x^(a+b)
          const result = {};
          for (const n1 in left) {
            for (const n2 in right) {
              const n = Number(n1) + Number(n2);
              const cur = result[n] !== undefined ? result[n] : 0;
              const mul = _polyMul(left[n1], right[n2]);
              result[n] = _polyAdd(cur, mul);
            }
          }
          return result;
        }
        if (ast.op === '^') {
          // k^n (n 为正整数)
          if (ast.left.type === 'var' && ast.left.name === kName) {
            if (_isConstNum(ast.right)) {
              const n = Number(ast.right.value);
              if (n >= 0 && n <= 12 && Number.isInteger(n)) {
                const result = {};
                result[n] = 1;
                return result;
              }
            }
          }
          // c^n (c 是常数 / 不含 k) : 视为常数
          if (!_dependsOn(ast.left, kName) && _isConstNum(ast.right)) {
            const c = Number(ast.left.value);
            const n = Number(ast.right.value);
            const v = Math.pow(c, n);
            return { 0: v };
          }
          return null;
        }
        if (ast.op === '/') {
          // 只支持 c/k^n (c 不含 k, n 正整数)
          if (ast.right.type === 'var' && ast.right.name === kName) {
            // body / k  ->  body * k^-1, 视为负幂
            // 这里不支持负幂, 返回 null
            return null;
          }
          //  c / (k^n) 也不支持
          if (!_dependsOn(ast.right, kName)) {
            // body / c
            const left = _decomposePolyInK(ast.left, kName);
            if (left === null) return null;
            const c = Number(ast.right.value);
            if (c === 0) return null;
            const result = {};
            for (const n in left) {
              const v = left[n];
              result[n] = (typeof v === 'number') ? v / c : _newBinop('/', v, ast.right);
            }
            return result;
          }
          return null;
        }
        return null;
      }
      case 'func':
        // sin(k), cos(k), e^k, ln(k) 等: 不是多项式
        return null;
    }
    return null;
  }

  // 多项式系数运算 (number 或 AST 的简单加减乘)
  function _isZeroVal(v) {
    if (v === 0) return true;
    if (typeof v === 'number') return v === 0;
    // AST: 常数 0 视为 0
    if (v && v.type === 'num' && (v.value === 0 || v.value === 0n)) return true;
    return false;
  }
  function _polyAdd(a, b) {
    if (a === 0) return b;
    if (b === 0) return a;
    if (typeof a === 'number' && typeof b === 'number') return a + b;
    return _newBinop('+', _toAst(a), _toAst(b));
  }
  function _polySub(a, b) {
    if (a === 0) return (typeof b === 'number') ? -b : _newUnary('-', b);
    if (b === 0) return a;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return _newBinop('-', _toAst(a), _toAst(b));
  }
  function _polyMul(a, b) {
    if (a === 0 || b === 0) return 0;
    if (a === 1) return b;
    if (b === 1) return a;
    if (a === -1) return (typeof b === 'number') ? -b : _newUnary('-', b);
    if (b === -1) return (typeof a === 'number') ? -a : _newUnary('-', a);
    if (typeof a === 'number' && typeof b === 'number') return a * b;
    return _newBinop('*', _toAst(a), _toAst(b));
  }
  function _toAst(v) {
    if (typeof v === 'number') return _newNum(v);
    return v;
  }

  function _symbolicDiff(ast, varName) {
    if (!ast) return _newNum(0);
    switch (ast.type) {
      case 'num':
        return _newNum(0);
      case 'var':
        return _newNum(ast.name === varName ? 1 : 0);
      case 'unary': {
        if (ast.op === '+') return _symbolicDiff(ast.operand, varName);
        if (ast.op === '-') {
          // d(-u) = -du
          return _newUnary('-', _symbolicDiff(ast.operand, varName));
        }
        throw new Error('unsupported: cannot differentiate "' + ast.op + '"');
      }
      case 'binop': {
        const u = ast.left, v = ast.right;
        const du = _symbolicDiff(u, varName);
        const dv = _symbolicDiff(v, varName);
        switch (ast.op) {
          case '+': return _newBinop('+', du, dv);
          case '-': return _newBinop('-', du, dv);
          case '*':
            // d(u*v) = du*v + u*dv
            return _newBinop('+',
              _newBinop('*', du, v),
              _newBinop('*', u, dv));
          case '/': {
            // d(u/v) = (du*v - u*dv) / v^2
            return _newBinop('/',
              _newBinop('-',
                _newBinop('*', du, v),
                _newBinop('*', u, dv)),
              _newBinop('^', v, _newNum(2)));
          }
          case '^': {
            // 区分 u, v 是否依赖 x
            const uHas = _dependsOn(u, varName);
            const vHas = _dependsOn(v, varName);
            if (!uHas && !vHas) return _newNum(0);
            if (!vHas) {
              // d(u^v) = v * u^(v-1) * du
              return _newBinop('*',
                _newBinop('*', v, _newBinop('^', u, _newBinop('-', v, _newNum(1)))),
                du);
            }
            if (!uHas) {
              // d(a^v) = a^v * ln(a) * dv
              return _newBinop('*',
                _newBinop('*', ast, _newFunc('ln', [u])),
                dv);
            }
            // u, v 都依赖 x:  d(u^v) = u^v * (dv*ln(u) + v*du/u)
            return _newBinop('*',
              ast,
              _newBinop('+',
                _newBinop('*', dv, _newFunc('ln', [u])),
                _newBinop('*', v, _newBinop('/', du, u))));
          }
          default:
            throw new Error('unsupported: cannot differentiate "' + ast.op + '"');
        }
      }
      case 'func': {
        // 高阶函数 (multi-arg):  integrate / sum 用 Leibniz 规则
        //   ∫_{lo}^{hi} f(t, ...) dt  ->  f(hi) * hi' - f(lo) * lo'  (f 不依赖 x)
        //   r15: 若 f 依赖 x, 完整 Leibniz 公式:
        //     d/dx ∫_{lo(x)}^{hi(x)} f(x, t) dt
        //       = f(x, hi(x)) * hi'(x) - f(x, lo(x)) * lo'(x) + ∫_{lo(x)}^{hi(x)} ∂f/∂x dt
        //   例: d/dx [∫₀ˣ (x-t) sin(t) dt] = 0 - 0 + ∫₀ˣ sin(t) dt
        if (ast.name === 'integrate' && ast.args.length === 4) {
          const f   = ast.args[0];
          const t   = ast.args[1];
          const lo  = ast.args[2];
          const hi  = ast.args[3];
          const dhi = _symbolicDiff(hi, varName);
          const dlo = _symbolicDiff(lo, varName);
          if (_dependsOn(f, varName)) {
            // 完整 Leibniz: 端点项 + 内部偏导项
            //   端点项: f(x=hi) * hi' - f(x=lo) * lo'
            //   内部项: ∫_{lo}^{hi} ∂f/∂x dt
            const fAtHi = _substituteVar(f, t.name, hi);
            const fAtLo = _substituteVar(f, t.name, lo);
            const dfDx  = _symbolicDiff(f, varName);  // 偏导
            const inner = _newFunc('integrate', [dfDx, t, lo, hi]);
            // 端点项 - 当 fAtLo 中 t 已替换为 lo, 若 fAtLo 还依赖 x, 它就是 f(x, lo(x))
            // 这里保持 fAtLo/fAtHi 原样 (lo/hi 表达式可能依赖 x, 但当前用 fAtHi 已经是 f(hi) 形式)
            // 实际更精确: fAtHi 应是 f(x, hi(x)) - 但因为 hi 本身可能含 x, 替换 t→hi 已带入
            const endpointTerm = _newBinop('-',
              _newBinop('*', fAtHi, dhi),
              _newBinop('*', fAtLo, dlo));
            return _newBinop('+', endpointTerm, inner);
          }
          const fAtHi = _substituteVar(f, t.name, hi);
          const fAtLo = _substituteVar(f, t.name, lo);
          return _newBinop('-', _newBinop('*', fAtHi, dhi), _newBinop('*', fAtLo, dlo));
        }
        //   ∑_{k=lo}^{hi} body(k, ...)
        //   简单 Leibniz 规则 body(k=hi)*hi' - body(k=lo)*lo'  对连续函数才精确
        //   对求和应当用 Faulhaber / Bernoulli 多项式:
        //     d/dx ∑_{k=lo}^{hi} c_n * k^n  =  c_n * (B_n(hi+1) * hi' - B_n(lo) * lo')
        //   其中 B_n 是第 n 个伯努利多项式
        if (ast.name === 'sum' && ast.args.length === 4) {
          const k    = ast.args[0];
          const lo   = ast.args[1];
          const hi   = ast.args[2];
          const body = ast.args[3];
          if (_dependsOn(body, varName) && !_dependsOn(body, k.name)) {
            // 特殊情况: body 依赖 varName 但不依赖 k
            //   整个 sum = body * (hi - lo + 1)  (如果 lo/hi 是 const, 否则走 Leibniz)
            //   例: d/dx[sum(k,1,2,sum(j,1,3, j*x))] = sum(j,1,3,j*x)' * 2 = 12
            if (_isConstNum(lo) && _isConstNum(hi)) {
              const count = _newNum(Math.abs(Number(hi.value) - Number(lo.value)) + 1);
              return _newBinop('*', count, _symbolicDiff(body, varName));
            }
            // 上下界是变量: 走 Leibniz
            const dhi = _symbolicDiff(hi, varName);
            const dlo = _symbolicDiff(lo, varName);
            const bodyAtHi = _substituteVar(body, k.name, hi);
            const bodyAtLo = _substituteVar(body, k.name, lo);
            return _newBinop('-',
              _newBinop('*', bodyAtHi, dhi),
              _newBinop('*', bodyAtLo, dlo));
          }
          if (_dependsOn(body, varName)) {
            // 通用情况: body 同时依赖 k 和 varName
            //   d/dx Σ body(k, x) = Σ d/dx[body(k, x)]  (交换求和与求导, 对有限和/收敛级数成立)
            //   例: d/dx[sum(k,1,3, k*x)] = sum(k,1,3, k)
            //   例: d/dx[sum(k,1,3, k*x^2)] = 2x * sum(k,1,3, k) = 12x
            const dBody = _symbolicDiff(body, varName);
            return _newFunc('sum', [k, lo, hi, dBody]);
          }
          // 尝试把 body 分解为 k 的多项式
          const poly = _decomposePolyInK(body, k.name);
          if (poly === null) {
            // body 不是 k 的多项式 (含 sin(k)/exp(k)/k^x 等), 退回简单 Leibniz (近似)
            const dhi = _symbolicDiff(hi, varName);
            const dlo = _symbolicDiff(lo, varName);
            const bodyAtHi = _substituteVar(body, k.name, hi);
            const bodyAtLo = _substituteVar(body, k.name, lo);
            return _newBinop('-', _newBinop('*', bodyAtHi, dhi), _newBinop('*', bodyAtLo, dlo));
          }
          // 多项式情形:  按次数 n 累加 c_n * (B_n(hi+1) * hi' - B_n(lo) * lo')
        const dhi = _symbolicDiff(hi, varName);
        const dlo = _symbolicDiff(lo, varName);
        const hiPlus1 = _newBinop('+', hi, _newNum(1));
          let result = null;
          for (const nStr in poly) {
            const c = poly[nStr];
            if (_isZeroVal(c)) continue;
            const n = parseInt(nStr);
            const BnAtHiPlus1 = _bernoulliPoly(n, hiPlus1);
            const BnAtLo      = _bernoulliPoly(n, lo);
            const term1 = _newBinop('*', BnAtHiPlus1, dhi);
            const term2 = _newBinop('*', BnAtLo,      dlo);
            let contrib = _newBinop('-', term1, term2);
            // 乘以 c_n
            if (typeof c === 'number') {
              if (c !== 1) contrib = _newBinop('*', _newNum(c), contrib);
            } else {
              contrib = _newBinop('*', c, contrib);
            }
            result = result ? _newBinop('+', result, contrib) : contrib;
        }
        return result || _newNum(0);
        }
        //   ∏_{k=lo}^{hi} body(k, ...)  Leibniz 规则:
        //     d/dx ∏ body = ∏ body * ∑ (body' / body)
        //     = ∑ body' * ∏_{j≠k} body(j)
        //     简化形式: P(x) * Σ body' / body  (要求 body 不为 0)
        if (ast.name === 'product' && ast.args.length === 4) {
          const k    = ast.args[0];
          const lo   = ast.args[1];
          const hi   = ast.args[2];
          const body = ast.args[3];
          if (_dependsOn(body, varName)) {
            // f' = product(k, lo, hi, body) * sum(k, lo, hi, body' / body)
            const fullProd   = _newFunc('product', [k, lo, hi, body]);
            const dkbody     = _symbolicDiff(body, varName);
            const dkbodyOver = _newBinop('/', dkbody, body);
            const sumOver    = _newFunc('sum', [k, lo, hi, dkbodyOver]);
            return _newBinop('*', fullProd, sumOver);
          }
          // body 不依赖 x, product 是常数, 导数 = 0
          return _newNum(0);
        }
        // 通用: 1-arg 函数, 单变量链式法则
        if (ast.args.length !== 1) {
          throw new Error('unsupported: ' + ast.name + '() with ' + ast.args.length + ' args (need 1)');
        }
        const arg = ast.args[0];
        const du = _symbolicDiff(arg, varName);
        switch (ast.name) {
          case 'sin':
            return _newBinop('*', _newFunc('cos', [arg]), du);
          case 'cos':
            return _newBinop('*', _newUnary('-', _newFunc('sin', [arg])), du);
          case 'tan': {
            // d(tan u) = sec^2(u) * du = (1 + tan^2(u)) * du
            return _newBinop('*',
              _newBinop('+', _newNum(1), _newBinop('^', ast, _newNum(2))),
              du);
          }
          case 'asin':
            return _newBinop('*',
              _newBinop('/', _newNum(1),
                _newFunc('sqrt', [_newBinop('-', _newNum(1), _newBinop('^', arg, _newNum(2)))])),
              du);
          case 'acos':
            return _newBinop('*',
              _newUnary('-',
                _newBinop('/', _newNum(1),
                  _newFunc('sqrt', [_newBinop('-', _newNum(1), _newBinop('^', arg, _newNum(2)))]))),
              du);
          case 'atan':
            return _newBinop('*',
              _newBinop('/', _newNum(1),
                _newBinop('+', _newNum(1), _newBinop('^', arg, _newNum(2)))),
              du);
          case 'sinh':
            return _newBinop('*', _newFunc('cosh', [arg]), du);
          case 'cosh':
            return _newBinop('*', _newFunc('sinh', [arg]), du);
          case 'tanh': {
            // d(tanh u) = sech^2(u) * du = (1 - tanh^2(u)) * du
            return _newBinop('*',
              _newBinop('-', _newNum(1), _newBinop('^', ast, _newNum(2))),
              du);
          }
          case 'exp':
            // d(e^u) = e^u * du
            return _newBinop('*', _newFunc('exp', [arg]), du);
          case 'ln':
          case 'log':
            // d(ln u) = du / u
            return _newBinop('*', _newBinop('/', du, arg), _newNum(1));
          case 'log10':
            // d(log10 u) = du / (u * ln 10)
            return _newBinop('*',
              _newBinop('/',
                du,
                _newBinop('*', arg, _newFunc('ln', [_newNum(10)]))),
              _newNum(1));
          case 'sqrt':
            // d(sqrt u) = du / (2 * sqrt u)
            return _newBinop('*',
              _newBinop('/',
                du,
                _newBinop('*', _newNum(2), _newFunc('sqrt', [arg]))),
              _newNum(1));
          case 'erf':
            // r15: d(erf u) = 2/sqrt(pi) * exp(-u^2) * du
            //   用具体 Math.PI 值 (常数) 而不是 pi() (parser 不支持 0 参函数 pi)
            return _newBinop('*',
              _newBinop('*',
                _newBinop('/',
                  _newNum(2),
                  _newFunc('sqrt', [_newNum(Math.PI)])),
                _newFunc('exp', [_newBinop('-', _newNum(0), _newBinop('^', arg, _newNum(2)))])),
              du);
          case 'abs':
            // d(|u|) = sign(u) * du.  sign(u) 用 u/|u| 表示 (u=0 时未定义, 抛错)
            return _newBinop('*',
              _newBinop('/', arg, _newFunc('abs', [arg])),
              du);
          case 'floor':
          case 'ceil':
            // 不连续函数, 导数几乎处处为 0
            return _newNum(0);
          case 'log2':
            // d(log2 u) = du / (u * ln 2)
            return _newBinop('*',
              _newBinop('/',
                du,
                _newBinop('*', arg, _newFunc('ln', [_newNum(2)]))),
              _newNum(1));
          case 'asinh':
            return _newBinop('*',
              _newBinop('/',
                _newNum(1),
                _newFunc('sqrt', [_newBinop('+', _newNum(1), _newBinop('^', arg, _newNum(2)))])),
              du);
          case 'acosh':
            return _newBinop('*',
              _newBinop('/',
                _newNum(1),
                _newFunc('sqrt', [_newBinop('-', _newBinop('^', arg, _newNum(2)), _newNum(1))])),
              du);
          case 'atanh':
            return _newBinop('*',
              _newBinop('/',
                _newNum(1),
                _newBinop('-', _newNum(1), _newBinop('^', arg, _newNum(2)))),
              du);
          default:
            throw new Error('unsupported: cannot differentiate "' + ast.name + '()"');
        }
      }
    }
    throw new Error('unsupported AST node: ' + ast.type);
  }

  // 简化: 折叠常数, 0/x, x^0, x^1, ...
  //   对 + 和 * 做扁平化收集所有操作数, 这样能跨多层折叠: 5*(3*x^2) -> 15*x^2
  function _flattenBinop(ast, op) {
    // 返回扁平后的操作数数组 (按出现顺序)
    const out = [];
    (function helper(n) {
      if (n && n.type === 'binop' && n.op === op) {
        helper(n.left);
        helper(n.right);
      } else {
        out.push(n);
      }
    })(ast);
    return out;
  }

  // _simplifyAst(ast, options?)
  //   options.skipFuncEval:  保留函数调用表达式, 不通过 Math.sin/cos/ln 等求值
  //     (用于符号积分结果, 保留 ln(2) 这种常数函数形式)
  function _simplifyAst(ast, options) {
    if (!ast) return ast;
    switch (ast.type) {
      case 'num':
      case 'var':
        return ast;
      case 'unary': {
        const op = _simplifyAst(ast.operand, options);
        if (op.type === 'num' && _isConstNum(op)) {
          if (ast.op === '+') return op;
          if (ast.op === '-') return _newNum(-Number(op.value));
        }
        // -(-x) = x
        if (ast.op === '-' && op.type === 'unary' && op.op === '-') {
          return op.operand;
        }
        // ★ skipFuncEval 模式: 保留一元 -, 避免 -(f(x)) 被改成 -1*f(x) 的丑格式
        if (options && options.skipFuncEval && ast.op === '-') {
          return _newUnary('-', op);
        }
        // ★ 把 -X 转换为 (-1) * X  (X 不是 num 时)
        //   这样 -(A*B) 变成 (-1)*A*B, 让 const 折叠和幂次合并能正确处理
        //   例:  2x * -(2x*sin)  ->  2x * (-1) * 2x * sin  ->  -4*x^2*sin
        //   r15-amend-simplify-cancellation: 必须递归 simplify 新 binop, 让 (-1)*X 折叠回 -X
        //   之前直接返回 _newBinop('*', -1, op), 上层不再次 simplify, 出现 -1sin(x) 丑格式
        if (ast.op === '-') {
          return _simplifyAst(_newBinop('*', _newNum(-1), op), options);
        }
        return _newUnary(ast.op, op);
      }
      case 'binop': {
        const l = _simplifyAst(ast.left, options);
        const r = _simplifyAst(ast.right, options);
        const op = ast.op;

        // ★ 分配律: 乘法遇到 + 操作数时, 展开分配
        //   例:  2 * (0.5 + x)  ->  1 + 2x
        //   例:  c * (a + b)    ->  c*a + c*b
        //   否则现有的 * 简化会把 (0.5+x) 当成单个 other, 漏掉 consts 对 + 内项的贡献
        if (op === '*') {
          if (l.type === 'binop' && l.op === '+') {
            // r * (a + b)  ->  r*a + r*b
            const terms = _flattenBinop(l, '+');
            const parts = terms.map(t => _newBinop('*', r, t));
            return _simplifyAst(parts.reduce((a, b) => _newBinop('+', a, b)), options);
          }
          if (r.type === 'binop' && r.op === '+') {
            // l * (a + b)  ->  l*a + l*b
            const terms = _flattenBinop(r, '+');
            const parts = terms.map(t => _newBinop('*', l, t));
            return _simplifyAst(parts.reduce((a, b) => _newBinop('+', a, b)), options);
          }
        }

        // 对 + 和 * 做扁平化 + 常数折叠 + 幂次合并
        if (op === '+' || op === '*') {
          const operands = _flattenBinop({ type: 'binop', op, left: l, right: r }, op);
          const consts = [];
          const vars = [];
          for (const o of operands) {
            if (_isConstNum(o)) consts.push(Number(o.value));
            else vars.push(o);
          }
          if (op === '+') {
            const sum = consts.reduce((a, b) => a + b, 0);
            // 合并同类项:  c1*A + c2*A = (c1+c2)*A
            //   每个 term 分解为 (coeff, polyMap, others), signature = (polyMap, others) 排序字符串
            //   相同 signature 的项合并系数
            const groups = new Map();  // key -> { coeff, poly: {var: pow}, others: [...] }
            function _addToGroup(term) {
              // 递归分解 term, 收集 coeff, polyMap, others
              const stack = [term];
              let coeff = 1, sign = 1;
              const poly = new Map();
              const others = [];
              while (stack.length) {
                const t = stack.pop();
                if (!t) continue;
                if (t.type === 'num' && _isConstNum(t)) {
                  coeff *= sign * Number(t.value);
                  sign = 1;
                } else if (t.type === 'unary' && t.op === '-') {
                  // ★ 修复: 如果 operand 是简单节点 (num/var/var^n), 只翻 sign;
                  //   如果是复杂表达式 (如 (x+1), sin(x)), 把 -1 折进 coeff, 避免符号信息丢失
                  //   例:  -(x+1)  ->  coeff=-1, others=[(x+1)]  (而不是 sign=-1, others=[(x+1)] 丢失符号)
                  const op = t.operand;
                  const isSimple = op.type === 'num' || op.type === 'var' ||
                    (op.type === 'binop' && op.op === '^' && op.left.type === 'var' && _isConstNum(op.right)) ||
                    (op.type === 'binop' && op.op === '*' && /* 处理 -X*Y, 见下方 */ false);
                  if (isSimple) {
                    sign = -sign;
                    stack.push(op);
                  } else {
                    coeff *= sign * -1;
                    sign = 1;
                    stack.push(op);
                  }
                } else if (t.type === 'unary' && t.op === '+') {
                  stack.push(t.operand);
                } else if (t.type === 'var') {
                  poly.set(t.name, (poly.get(t.name) || 0) + sign);
                  sign = 1;
                } else if (t.type === 'binop' && t.op === '^' &&
                           t.left.type === 'var' && _isConstNum(t.right)) {
                  poly.set(t.left.name, (poly.get(t.left.name) || 0) + sign * Number(t.right.value));
                  sign = 1;
                } else if (t.type === 'binop' && t.op === '*') {
                  stack.push(t.right);
                  stack.push(t.left);
                } else if (t.type === 'binop' && t.op === '/' && t.left.type === 'num' && _isConstNum(t.left) &&
                           (t.right.type === 'num' || t.right.type === 'var' ||
                            (t.right.type === 'binop' && t.right.op === '^' && t.right.left.type === 'var' && _isConstNum(t.right.right)))) {
                  // (c/n) * x   ->  把 c/n 算到 coeff 里 (仅当 n 是简单 var/num/var^const)
                  //   防止 1/(1+x) + 1/(2+x) 被错误化简: 分母是 (1+x) 复杂表达式, 应原样保留
                  //   例: 1/2 * x -> coeff=0.5, others=[x]   OK
                  //   例: 1/x * y -> coeff=1, poly={x:-1}, others=[y]   OK
                  //   例: 1/(1+x) * y -> others=[1/(1+x)*y]  保留 (不能折进 coeff, 否则通分出问题)
                  if (t.right.type === 'num') {
                    coeff *= sign / Number(t.right.value);
                    sign = 1;
                  } else if (t.right.type === 'var') {
                    // 1/x 折成 x^(-1) 进入 poly (因为 _addToGroup 不支持 var^(-1), 推到 others)
                    // 实际: 1/x 不折进 coeff, 而是作为一个整体的 others 项 (但用 x^-1 等价)
                    others.push({ sign, ast: t });
                    sign = 1;
                  } else {
                    // var^const (例如 1/x^2)
                    const e = Number(t.right.right.value);
                    const varName = t.right.left.name;
                    poly.set(varName, (poly.get(varName) || 0) - e);
                    sign = 1;
                  }
                } else {
                  others.push({ sign, ast: t });
                  sign = 1;
                }
              }
              // poly key:  {var:pow, ...} 按 var 排序
              const polyKey = [...poly.entries()].sort((a, b) => a[0].localeCompare(b[0]))
                                .map(([v, p]) => v + '^' + p).join(',');
              // others key:  按字符串化排序, sign 不影响 signature
              const othersKey = others.map(o => _astToString(o.ast)).sort().join('|');
              const key = polyKey + '@' + othersKey;
              let g = groups.get(key);
              if (!g) {
                g = { coeff: coeff, poly: new Map(poly), others: others.map(o => o.ast) };
                groups.set(key, g);
              } else {
                g.coeff += coeff;
              }
            }
            for (const v of vars) _addToGroup(v);
            // 构造结果:  常数 + 各组合并后的 term (按 signature 排序, 输出更稳定)
            // 用 terms + negative flag, 然后用 binary +/- op 拼接, 避免 + -N 丑格式
            //   例:  2*cos(x^2) + -4*x^2*sin(x^2)  ->  2*cos(x^2) - 4*x^2*sin(x^2)
            const terms = [];   // [{ negative: bool, ast: <coeff * poly * others> }]
            if (sum !== 0) terms.push({ negative: sum < 0, ast: _newNum(Math.abs(sum)) });
            const sortedKeys = [...groups.keys()].sort();
            for (const key of sortedKeys) {
              const g = groups.get(key);
              if (g.coeff === 0) continue;  // 合并后抵消
              const absCoeff = Math.abs(g.coeff);
              // 构造 term:  |coeff| * poly * others (用绝对值)
              const parts = [];
              if (absCoeff !== 1) parts.push(_newNum(absCoeff));
              for (const [varName, power] of [...g.poly.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
                if (power === 0) continue;
                else if (power === 1) parts.push(_newVar(varName));
                else parts.push(_newBinop('^', _newVar(varName), _newNum(power)));
              }
              for (const o of g.others) parts.push(o);
              // ★ 修复: 仅有常数系数 (无 var, 无 other) 时, 也要把它作为常数项输出
              //   例: coeff=-1, poly={}, others=[]  ->  -1 (而不是 continue 丢掉)
              if (parts.length === 0) {
                if (absCoeff === 0) continue;
                parts.push(_newNum(absCoeff));
              }
              const termAst = parts.length === 1 ? parts[0] : parts.reduce((a, b) => _newBinop('*', a, b));
              terms.push({ negative: g.coeff < 0, ast: termAst });
            }
            if (terms.length === 0) return _newNum(0);  // 全抵消
            if (terms.length === 1) {
              const t = terms[0];
              if (!t.negative) return t.ast;
              if (t.ast.type === 'num') return _newNum(-Number(t.ast.value));
              return _newUnary('-', t.ast);  // 一元 -
            }
            // r15-amend-simplify-cancellation: 项对消 (a + (-a) 互消)
            //   把互为相反数的两项 (一个 unary -, 一个正项, AST 相同) 删掉
            //   注意: 必须 O(n²) pairwise, 避免哈希 key 算反 (这里只关心"完全相同"的对消)
            for (let i = 0; i < terms.length; i++) {
              if (!terms[i]) continue;
              for (let j = i + 1; j < terms.length; j++) {
                if (!terms[j]) continue;
                if (_astNegPair(terms[i], terms[j])) {
                  terms[i] = null;
                  terms[j] = null;
                  break;
                }
              }
            }
            const filteredTerms = terms.filter(t => t !== null);
            if (filteredTerms.length === 0) return _newNum(0);  // 全抵消
            // 多项:  用 binary +/- 拼接
            // ★ reduce 的 initial value 是 acc, t 从 terms[0] 开始迭代, 所以需要 slice(1)
            return filteredTerms.slice(1).reduce((acc, t) => {
              return t.negative ? _newBinop('-', acc, t.ast) : _newBinop('+', acc, t.ast);
            }, filteredTerms[0].ast);
          } else {
            // *  合并同类幂:  x*x -> x^2, x*x^2 -> x^3, x^2*x^3 -> x^5
            //   识别 var (即 var^1) 和 var^const 两类, 累加幂次
            //   额外:  X/c  (c 为常数)  ->  把 1/c 折进 consts, 让 c*(1/c) 抵消
            //     例:  3 * (x^3/3)  ->  consts=[3, 1/3] -> 1*x^3 = x^3
            if (consts.indexOf(0) >= 0) return _newNum(0);
            const powerMap = new Map();   // varName -> 累加后的 power
            const others = [];             // 非幂次项 (函数调用, 复杂表达式等)
            for (const v of vars) {
              if (v.type === 'var') {
                powerMap.set(v.name, (powerMap.get(v.name) || 0) + 1);
              } else if (v.type === 'binop' && v.op === '^' &&
                         v.left.type === 'var' && _isConstNum(v.right)) {
                const e = Number(v.right.value);
                powerMap.set(v.left.name, (powerMap.get(v.left.name) || 0) + e);
              } else if (v.type === 'binop' && v.op === '/' && _isConstNum(v.right)) {
                // X / c:  把 1/c 折进 consts, 处理 X
                consts.push(1 / Number(v.right.value));
                const x = v.left;
                if (x.type === 'var') {
                  powerMap.set(x.name, (powerMap.get(x.name) || 0) + 1);
                } else if (x.type === 'binop' && x.op === '^' &&
                           x.left.type === 'var' && _isConstNum(x.right)) {
                  const e = Number(x.right.value);
                  powerMap.set(x.left.name, (powerMap.get(x.left.name) || 0) + e);
                } else {
                others.push(x);
              }
            } else if (v.type === 'binop' && v.op === '/' && _isConstNum(v.left) &&
                       (v.right.type === 'var' ||
                        (v.right.type === 'binop' && v.right.op === '^' &&
                         v.right.left.type === 'var' && _isConstNum(v.right.right)))) {
              // ★ Bug 96(b) 修复: c / X (c 为常数分子, X 为 var 或 var^const) -> c 折进 consts, X 折成负幂次
              //   例: 1/x -> consts=[1], powerMap[x] -= 1  (与 x 配对抵消: x*(1/x) = 1)
              //   例: 2/x^3 -> consts=[2], powerMap[x] -= 3
              //   之前漏处理此模式, 导致 2*x*(1/x) 不化简为 2, 二阶导出错
              consts.push(Number(v.left.value));
              if (v.right.type === 'var') {
                powerMap.set(v.right.name, (powerMap.get(v.right.name) || 0) - 1);
              } else {
                const e = Number(v.right.right.value);
                powerMap.set(v.right.left.name, (powerMap.get(v.right.left.name) || 0) - e);
              }
            } else if (v.type === 'unary' && v.op === '-') {
              // unary -:  把 -1 折进 consts, 处理 operand
                consts.push(-1);
                const x = v.operand;
                if (x.type === 'var') {
                  powerMap.set(x.name, (powerMap.get(x.name) || 0) + 1);
                } else if (x.type === 'binop' && x.op === '^' &&
                           x.left.type === 'var' && _isConstNum(x.right)) {
                  const e = Number(x.right.value);
                  powerMap.set(x.left.name, (powerMap.get(x.left.name) || 0) + e);
                } else {
                  others.push(x);
                }
              } else {
                others.push(v);
              }
            }
            const prod = consts.reduce((a, b) => a * b, 1);
            const result = [];
            // ★ prod === -1 时不要推 -1, 而是把整个结果包到 unary - 里, 避免 -1*X 的丑格式
            if (prod !== 1 && prod !== -1) result.push(_newNum(prod));
            // 按 var 名排序, 让 x^2 排在 y 之前, 输出更可读
            for (const [varName, power] of [...powerMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
              if (power === 0) continue;             // x^0 = 1, 跳过
              else if (power === 1) result.push(_newVar(varName));
              else result.push(_newBinop('^', _newVar(varName), _newNum(power)));
            }
            for (const o of others) result.push(o);
            if (result.length === 0) {
              // 仅 const, prod 决定结果
              return _newNum(prod);
            }
            let combined = result.length === 1 ? result[0] : result.reduce((a, b) => _newBinop('*', a, b));
            if (prod === -1) combined = _newUnary('-', combined);
            return combined;
          }
        }

        // 0+x / x+0 / 0-x / x-0
        // r15-amend-simplify-cancellation: 加结构相等判断 (x-x=0, sin(x)-sin(x)=0)
        if (op === '-') {
          if (_isZeroNode(r)) return l;
          if (_isZeroNode(l)) return _newUnary('-', r);
          if (_isConstNum(l) && _isConstNum(r)) return _newNum(Number(l.value) - Number(r.value));
          if (_astEqual(l, r)) return _newNum(0);
        }
        // 0/x = 0; x/1 = x; x/x = 1
        if (op === '/') {
          if (_isZeroNode(l)) return _newNum(0);
          if (_isOneNode(r)) return l;
          if (_isConstNum(l) && _isConstNum(r) && Number(r.value) !== 0) {
            return _newNum(Number(l.value) / Number(r.value));
          }
          if (l.type === 'var' && r.type === 'var' && l.name === r.name) return _newNum(1);
        }
        // x^0=1; x^1=x; 0^x=0; 1^x=1
        if (op === '^') {
          if (_isZeroNode(r)) return _newNum(1);
          if (_isOneNode(r)) return l;
          if (_isZeroNode(l) && _isConstNum(r)) return _newNum(0);
          if (_isOneNode(l)) return _newNum(1);
          if (_isConstNum(l) && _isConstNum(r)) {
            const lv = Number(l.value), rv = Number(r.value);
            const v = Math.pow(lv, rv);
            if (Number.isFinite(v)) return _newNum(v);
          }
        }
        return _newBinop(op, l, r);
      }
      case 'func': {
        const args = ast.args.map(a => _simplifyAst(a, options));
        // ★ skipFuncEval 模式: 保留函数调用表达式 (用于符号积分结果, 保留 ln(2) 等)
        if (options && options.skipFuncEval) {
          return _newFunc(ast.name, args);
        }
        // 常数折叠: 全部参数是数字, 或参数是已知常数 (e, pi 等), 走 JS 求值
        //   这样 ln(e)=1, sin(pi)=0, exp(0)=1, sqrt(4)=2 都能化简
        if (args.every(a =>
              a.type === 'num' || (a.type === 'var' && Object.prototype.hasOwnProperty.call(CONSTANTS, a.name))
            )) {
          const tryFuncs = {
            'sin': Math.sin, 'cos': Math.cos, 'tan': Math.tan,
            'asin': Math.asin, 'acos': Math.acos, 'atan': Math.atan,
            'sinh': Math.sinh, 'cosh': Math.cosh, 'tanh': Math.tanh,
            'exp': Math.exp, 'ln': Math.log, 'log': Math.log,
            'log10': Math.log10, 'sqrt': Math.sqrt
          };
          if (tryFuncs[ast.name]) {
            try {
              const arg = args[0];
              const v = (arg.type === 'num')
                ? Number(arg.value)
                : CONSTANTS[arg.name];
              const r = tryFuncs[ast.name](v);
              if (Number.isFinite(r)) return _newNum(r);
            } catch (e) { /* keep symbolic */ }
          }
        }
        return _newFunc(ast.name, args);
      }
    }
    return ast;
  }

  // AST 算符优先级 (用于序列化时加括号)
  function _precedence(ast) {
    if (!ast) return 5;
    switch (ast.type) {
      case 'num': case 'var': case 'func': return 5;
      case 'unary': return 4;
      case 'binop': {
        switch (ast.op) {
          case '+': case '-': return 1;
          case '*': case '/': case '%': return 2;
          case '^': return 3;
        }
      }
    }
    return 5;
  }

  // AST -> 字符串
  function _astToString(ast) {
    if (!ast) return '0';
    switch (ast.type) {
      case 'num':
        if (typeof ast.value === 'bigint') return ast.value.toString();
        return String(ast.value);
      case 'var':
        return ast.name;
      case 'unary': {
        const inner = _astToString(ast.operand);
        // 一元 - 作用于 binop 时必须加括号: -(a+b)
        if (ast.operand.type === 'binop') {
          if (ast.op === '-') return '-(' + inner + ')';
          if (ast.op === '+') return '+(' + inner + ')';
        }
        // ★ r15-amend10 (Bug 29): 阶乘 (!) 作用于 binop/unary 时必须加括号
        //   否则 (2*n+1)! 序列化为 2n+1!, ! 只绑定到 1 (factorial(1)) 而非整体
        if (ast.op === '!') {
          if (ast.operand.type === 'binop' || ast.operand.type === 'unary') {
            return '(' + inner + ')!';
          }
          return inner + '!';
        }
        return (ast.op === '-' ? '-' : '+') + inner;
      }
      case 'binop': {
        const myP = _precedence(ast);
        const lp = _precedence(ast.left);
        const rp = _precedence(ast.right);
        const l = _astToString(ast.left);
        const r = _astToString(ast.right);
        // ★ r15-amend8: 幂运算 (^) 左操作数是 unary (负号/正号) 时强制加括号
        //   避免 (-1)^n 被序列化为 -1^n (Python 解析 -1^n 为 -(1^n) 而非 (-1)^n)
        const forceLeftParen = (ast.op === '^' && ast.left && ast.left.type === 'unary');
        // 左操作数: 优先级更低才加括号, 或 ^ 的左 unary 必须加括号
        let left = (lp < myP || (lp === myP && (ast.op === '-' || ast.op === '/' || ast.op === '^')) || forceLeftParen)
          ? '(' + l + ')' : l;
        // 右操作数: 优先级更低, 或同级 (减/除/幂右结合) 时加括号
        let right = (rp < myP || (rp === myP && (ast.op === '-' || ast.op === '/' || ast.op === '^')))
          ? '(' + r + ')' : r;
        // ★ 隐式乘: * 运算, 右侧是变量/函数/左括号, 左侧是数字/变量/右括号, 省略 *
        //   例: 2*x -> 2x,  x*y -> x*y (保留, 避免 kx 误读为多字母变量),  2*sin(x) -> 2sin(x),  (x+1)*(x-1) -> (x+1)(x-1)
        //   规则:
        //     - left 末尾是数字: 始终省略 *  (2x, 2sin(x))
        //     - right 起始是已知函数 (字母后跟 '('): 省略 *  (2cos(x), x*cos(x) -> xcos(x); 但避免 kx 误读)
        //     - 其他: 保留 *  (k*x^k, x*2, k*x; 避免 kx/x2/kx^k 等多字母变量歧义)
        if (ast.op === '*') {
          const leftEnd = left[left.length - 1];
          const rightStart = right[0];
          // 规则 1: digit 在 left, 省略 *
          //   例: 2x, 2sin(x), 2(3)
          //   但若 right 是 binop '^' (幂), 必须保留 *, 否则 "0.5*2^x" 省略后变 "0.52^x"
          //   解析会被误读为 0.52^x (base=0.52)
          //   ★ 修复 r15-79: 若 left 是负数 (如 "-1"), 不能省略 *, 否则 "-1"*2x 拼成 "-12x" 误读为 -12*x
          if (leftEnd && /[0-9]/.test(leftEnd) && !/^-/.test(left)) {
            if (ast.right && ast.right.type === 'binop' && ast.right.op === '^') {
              return left + '*' + right;   // 必须保留 *
            }
            // ★ r15-amend9 Bug 1.2: right 是阶乘时必须保留 *, 否则 2*3! → 23! 被解析为 factorial(23)
            if (ast.right && ast.right.type === 'unary' && ast.right.op === '!') {
              return left + '*' + right;
            }
            // ★ r15-amend9 Bug 1.1: right 以 +/- 开头时必须保留 *, 否则 2*(-x) → 2-x 被解析为减法
            if (/^[+-]/.test(right)) {
              return left + '*' + right;
            }
            return left + right;
          }
          // 规则 2: right 起始是已知函数, 省略 *
          //   ★ Bug 74 修复: 仅当 left 末尾不是字母/下划线时才省略 *
          //     left 末尾是字母时 (如 x, 2x 中的 x), 省略 * 会拼成 xsin(x)/2xsin(x)
          //     被误读为多字母变量名; left 末尾是数字 (2) 或右括号 ) 时省略 * 安全
          if (rightStart && /[a-zA-Z]/.test(rightStart)) {
            const fnMatch = right.match(/^([A-Za-z_][A-Za-z0-9_]*)\(/);
            if (fnMatch && Object.prototype.hasOwnProperty.call(FUNCTIONS, fnMatch[1])) {
              if (!/[a-zA-Z_]$/.test(left)) {
                return left + right;   // left 末尾非字母 (数字/右括号等), 省略 * 安全
              }
              // left 末尾是字母, 落到规则 3 保留 *
            }
          }
          // 规则 3: letter-letter 拼接可能产生多字母变量歧义, 保留 *
          //   例: k*x^k -> k*x^k (kx^k 会被误读为 kx^k)
          return left + '*' + right;
        }
        return left + ast.op + right;
      }
      case 'func':
        return ast.name + '(' + ast.args.map(_astToString).join(',') + ')';
    }
    return '?';
  }

  // -----------------------------------------------------------------------
  // 符号不定积分:  ∫ expr dvar  ->  反导函数表达式 (不含 +C, 调用方自行添加)
  //   支持规则:
  //     ∫c dx = c*x                     (c 为常数)
  //     ∫x dx = x^2/2
  //     ∫x^n dx = x^(n+1)/(n+1)         (n != -1)
  //     ∫1/x dx = ln(|x|)
  //     ∫a^x dx = a^x/ln(a)             (a 为常数)
  //     ∫sin(x) dx = -cos(x)
  //     ∫cos(x) dx = sin(x)
  //     ∫tan(x) dx = -ln(|cos(x)|)
  //     ∫exp(x) dx = exp(x)
  //     ∫sinh(x) dx = cosh(x)
  //     ∫cosh(x) dx = sinh(x)
  //     ∫(a ± b) dx = ∫a dx ± ∫b dx
  //     ∫(c * u) dx = c * ∫u dx          (c 为常数 w.r.t. x)
  //   不支持 (抛错):  ∫u*v dx (u,v 都含 x, 需要分部积分), 复合函数 ∫f(g(x)) dx
  // -----------------------------------------------------------------------
  function _symbolicIntegrate(ast, varName) {
    switch (ast.type) {
      case 'num':
        // ∫c dx = c*x
        return _newBinop('*', ast, _newVar(varName));
      case 'var': {
        if (ast.name === varName) {
          // ∫x dx = x^2/2
          return _newBinop('/', _newBinop('^', _newVar(varName), _newNum(2)), _newNum(2));
        }
        // 其它变量当成常数:  ∫y dx = y*x
        return _newBinop('*', ast, _newVar(varName));
      }
      case 'unary': {
        if (ast.op === '+') return _symbolicIntegrate(ast.operand, varName);
        if (ast.op === '-') {
          // ∫(-u) dx = -∫u dx
          return _newUnary('-', _symbolicIntegrate(ast.operand, varName));
        }
        throw new Error('unsupported unary: ' + ast.op);
      }
      case 'binop': {
        if (ast.op === '+' || ast.op === '-') {
          const left = _symbolicIntegrate(ast.left, varName);
          const right = _symbolicIntegrate(ast.right, varName);
          return _newBinop(ast.op, left, right);
        }
        if (ast.op === '*') {
          // ∫(c * u) dx = c * ∫u dx   (c 与 x 无关)
          if (!_dependsOn(ast.left, varName)) {
            return _newBinop('*', ast.left, _symbolicIntegrate(ast.right, varName));
          }
          if (!_dependsOn(ast.right, varName)) {
            return _newBinop('*', ast.right, _symbolicIntegrate(ast.left, varName));
          }
          throw new Error('symbolicIntegrate: cannot integrate product ' + _astToString(ast) +
            ' (u*v with both depending on ' + varName + ' requires integration by parts)');
        }
        if (ast.op === '/') {
          // ∫(u/c) dx = (1/c)*∫u dx   (c 为常数)
          if (!_dependsOn(ast.right, varName)) {
            return _newBinop('/', _symbolicIntegrate(ast.left, varName), ast.right);
          }
          if (!_dependsOn(ast.left, varName)) {
            // ∫(c/u) dx
            //   1/x              ->  ln(|x|)
            //   c/x (c 为常数)   ->  c * ln(|x|)
            if (ast.right.type === 'var' && ast.right.name === varName) {
              if (_isOneNode(ast.left)) {
                return _newFunc('ln', [_newVar(varName)]);
              }
              return _newBinop('*', ast.left, _newFunc('ln', [_newVar(varName)]));
            }
            // ★ r8: c/u 反函数形式
            //   1/sqrt(x^2 + c)  ->  asinh(x/sqrt(c))         (c > 0)
            //   1/sqrt(x^2 - c)  ->  acosh(x/sqrt(c))         (c > 0, x > sqrt(c))
            //   1/sqrt(-x^2 + c) ->  asin(x/sqrt(c))          (c > 0)
            //   1/sqrt(a*x^2 + c) -> (系数折叠)               (a, c > 0)
            //   1/(x^2 + c)      ->  atan(x/sqrt(c))/sqrt(c)  (c > 0)
            //   c/u 通用: c0 * (上面结果)                       (c0 是常数)
            if (_isOneNode(ast.left)) {
              const u = ast.right;
              // u 可能是 sqrt(Q) 或直接 Q
              let isSqrt = false;
              let Q = null;
              if (u.type === 'func' && u.name === 'sqrt' && u.args.length === 1) {
                isSqrt = true;
                Q = u.args[0];
              } else if (u.type === 'binop') {
                Q = u;
              }
              if (Q) {
                // 把 Q 标准化为 a*x^2 + b 形式, 其中 a, b 是常数 (a 可正可负, b 是 const)
                //   例: x^2 + 1   -> a=1, b=1
                //       1 + x^2   -> a=1, b=1  (commutative)
                //       2*x^2 + 4 -> a=2, b=4
                //       4 - x^2   -> a=-1, b=4
                //       x^2 - 4   -> a=1, b=-4
                const cn = _coeffsAxx2PlusB(Q, varName);
                if (cn !== null) {
                  const aC = cn.a, bC = cn.b;
                  // ★ r8: 只处理 b != 0 (避免与 1/x^n 重复; 那走上面 ^ 分支)
                  if (aC !== 0 && bC !== 0) {
                    if (isSqrt) {
                      // ∫ dx / sqrt(a*x^2 + b)
                      if (aC > 0 && bC > 0) {
                        // asinh(x*sqrt(a/b)) / sqrt(a)
                        const sqrtA = _newFunc('sqrt', [_newNum(aC)]);
                        const sqrtB = _newFunc('sqrt', [_newNum(bC)]);
                        const ratio = _newBinop('/', sqrtA, sqrtB);
                        const arg = _newBinop('*', _newVar(varName), ratio);
                        return _newBinop('/', _newFunc('asinh', [arg]), sqrtA);
                      }
                      if (aC < 0 && bC > 0) {
                        // asin(x*sqrt(-a/b)) / sqrt(-a)
                        const aA = -aC;
                        const sqrtA = _newFunc('sqrt', [_newNum(aA)]);
                        const sqrtB = _newFunc('sqrt', [_newNum(bC)]);
                        const ratio = _newBinop('/', sqrtA, sqrtB);
                        const arg = _newBinop('*', _newVar(varName), ratio);
                        return _newBinop('/', _newFunc('asin', [arg]), sqrtA);
                      }
                      if (aC > 0 && bC < 0) {
                        // acosh(x*sqrt(a/-b)) / sqrt(a)    (x > sqrt(-b/a))
                        const aB = -bC;
                        const sqrtA = _newFunc('sqrt', [_newNum(aC)]);
                        const sqrtB = _newFunc('sqrt', [_newNum(aB)]);
                        const ratio = _newBinop('/', sqrtA, sqrtB);
                        const arg = _newBinop('*', _newVar(varName), ratio);
                        return _newBinop('/', _newFunc('acosh', [arg]), sqrtA);
                      }
                    } else {
                      // ∫ dx / (a*x^2 + b)
                      if (aC > 0 && bC > 0) {
                        // atan(x*sqrt(a/b)) / sqrt(a*b)
                        const sqrtAB = _newFunc('sqrt', [_newBinop('*', _newNum(aC), _newNum(bC))]);
                        const sqrtA = _newFunc('sqrt', [_newNum(aC)]);
                        const sqrtB = _newFunc('sqrt', [_newNum(bC)]);
                        const ratio = _newBinop('/', sqrtA, sqrtB);
                        const arg = _newBinop('*', _newVar(varName), ratio);
                        return _newBinop('/', _newFunc('atan', [arg]), sqrtAB);
                      }
                    }
                  }
                }
              }
            }
            throw new Error('symbolicIntegrate: cannot integrate c/u ' + _astToString(ast));
          }
          throw new Error('symbolicIntegrate: cannot integrate ' + _astToString(ast));
        }
        if (ast.op === '^') {
          // x^n:  ∫x^n dx = x^(n+1)/(n+1)
          //   n 可能是 num 或 unary(-, num)  (例如 x^-1)
          if (ast.left.type === 'var' && ast.left.name === varName) {
            let n = null;
            if (_isConstNum(ast.right)) n = Number(ast.right.value);
            else if (ast.right.type === 'unary' && ast.right.op === '-' && _isConstNum(ast.right.operand)) {
              n = -Number(ast.right.operand.value);
            }
            if (n !== null) {
              if (n === -1) {
                // ∫x^-1 dx = ln(|x|)
                return _newFunc('ln', [_newVar(varName)]);
              }
              return _newBinop('/',
                _newBinop('^', _newVar(varName), _newNum(n + 1)),
                _newNum(n + 1));
            }
          }
          // a^(kx):  ∫a^(kx) dx = a^(kx) / (k * ln(a))   (a 与 x 无关, k 是非零常数)
          //   涵盖 a^x (k=1) 和 e^(2x) (k=2) 等
          if (!_dependsOn(ast.left, varName)) {
            const rk = _extractLinearK(ast.right, varName);
            if (rk !== null && rk.k !== 0) {
              return _newBinop('/',
                ast,
                _newBinop('*', rk.kAst, _newFunc('ln', [ast.left])));
            }
          }
          // (u)^n 其中 u 不是 varName, n 是 const  (例如 sin(x)^2):  不支持
          throw new Error('symbolicIntegrate: cannot integrate ' + _astToString(ast));
        }
        throw new Error('unsupported binop: ' + ast.op);
      }
      case 'func': {
        const arg = ast.args[0];
        // ★ 先检测 f(kx) 形式: 提取 k (或 null = 不支持)
        //   var(x)    -> k=1
        //   k*x       -> k=常数
        //   其它      -> null (继续走下面的 "only support f(x) form" 检查)
        //   ★ k==1 时跳过 f(kx) shortcut, 走下面 "arg 是 var(x)" 分支 (避免无限递归)
        const rk = _extractLinearK(arg, varName);
        const SUPPORTED_FUNCS = {
          'sin': true, 'cos': true, 'tan': true,
          'exp': true, 'sinh': true, 'cosh': true,
          'asin': true, 'acos': true, 'atan': true
        };
        if (rk !== null && rk.k !== 1 && rk.k !== 0 && SUPPORTED_FUNCS[ast.name]) {
          // ∫f(kx) dx = F(kx) / k
          //   先把 f(kx) 改成 f(x) 求原函数 F(x), 再 substitute x -> arg (kx)
          //   用 _substituteVar 替换 F 中的 var(varName) -> arg
          const fAsX = _newFunc(ast.name, [_newVar(varName)]);
          const Fx = _symbolicIntegrate(fAsX, varName);   // ★ 递归, 必走 x form
          const Fkx = _substituteVar(Fx, varName, arg);
          return _newBinop('/', Fkx, rk.kAst);
        }
        if (!arg || arg.type !== 'var' || arg.name !== varName) {
          throw new Error('symbolicIntegrate: only support f(' + varName + ') form, not f(' + _astToString(arg) + ')');
        }
        switch (ast.name) {
          case 'sin':  return _newUnary('-', _newFunc('cos', [_newVar(varName)]));
          case 'cos':  return _newFunc('sin', [_newVar(varName)]);
          case 'tan':  return _newUnary('-', _newFunc('ln', [_newFunc('cos', [_newVar(varName)])]));
          case 'exp':  return _newFunc('exp', [_newVar(varName)]);
          case 'sinh': return _newFunc('cosh', [_newVar(varName)]);
          case 'cosh': return _newFunc('sinh', [_newVar(varName)]);
          case 'asin': return _newBinop('+',
                              _newBinop('*', _newVar(varName), _newFunc('asin', [_newVar(varName)])),
                              _newFunc('sqrt', [_newBinop('-', _newNum(1), _newBinop('^', _newVar(varName), _newNum(2)))]));
          case 'acos': return _newBinop('-',
                              _newBinop('*', _newVar(varName), _newFunc('acos', [_newVar(varName)])),
                              _newFunc('sqrt', [_newBinop('-', _newNum(1), _newBinop('^', _newVar(varName), _newNum(2)))]));
          case 'atan': return _newBinop('-',
                              _newBinop('*', _newVar(varName), _newFunc('atan', [_newVar(varName)])),
                              _newBinop('/', _newFunc('ln', [_newBinop('+', _newNum(1), _newBinop('^', _newVar(varName), _newNum(2)))]), _newNum(2)));
        }
        throw new Error('symbolicIntegrate: unsupported function ' + ast.name);
      }
    }
    throw new Error('symbolicIntegrate: cannot integrate ' + _astToString(ast));
  }

  // 公开接口: 符号不定积分, 表达式 -> 反导函数表达式字符串 (含 +C)
  //   失败时 (如 abs / 复杂函数) 抛错, 调用方应 fallback
  function symbolicIntegrate(input, varName) {
    if (!varName || typeof varName !== 'string') {
      throw new Error('symbolicIntegrate: varName is required');
    }
    const ast = parse(input);
    const iAst = _symbolicIntegrate(ast, varName);
    // ★ skipFuncEval: 保留 ln(2), sin(pi/2) 等常数函数形式, 不被 simplify 算成 0.693.../1
    const simplified = _simplifyAst(iAst, { skipFuncEval: true });
    return _astToString(simplified) + '+C';
  }

  // 公开接口: 符号求导, 表达式 -> 导函数表达式字符串
  //   失败时 (如 abs / !) 抛错, 调用方应 fallback 到数值
  function symbolicDiff(input, varName) {
    if (!varName || typeof varName !== 'string') {
      throw new Error('symbolicDiff: varName is required');
    }
    // r15-amend: 识别嵌套 diff(f, x) 形式, 递归 peel, 对最里层做 N 阶 symbolicDiff
    //   例: symbolicDiff('diff(diff(int(...),x),x)', 'x')  ->  2 阶导
    //        symbolicDiff('diff(sin(x),x)', 'x')          ->  1 阶导
    //   之前: 抛 'unsupported: diff() with 2 args (need 1)'
    //   原因: LaTeX \frac{d^2}{dx^2}[int...] 解析为 diff(diff(f,x),x), todo.js 的 diff regex
    //        截外层后调 symbolicDiff(diff(f,x), x) 失败, fallback 到 x=0 数值路径 → 返回 0
    let bodyStr = input;
    let order = 1;
    // regex 匹配最外层 diff(<body>, <varName>)
    //   注: regex 不能直接处理嵌套括号, 但这里 input 是已 evaluate 的字符串, 多次 apply 即可
    //   varName 转义: 实际都是字母, 但稳健起见 escape regex 特殊字符
    const escapedVar = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const diffRe = new RegExp(
      '^\\s*diff\\s*\\(\\s*(.+?)\\s*,\\s*' + escapedVar + '\\s*\\)\\s*$',
      'i'
    );
    while (true) {
      const m = bodyStr.match(diffRe);
      if (!m) break;
      bodyStr = m[1];
      order += 1;
    }
    if (order === 1) {
      // 普通情况, 用原逻辑
      const ast = parse(input);
      const dAst = _simplifyAst(_expandConstSum(_simplifyAst(_symbolicDiff(ast, varName))));
      return _astToString(dAst);
    }
    // 嵌套情况: 对最里层 bodyStr 做 N 阶 symbolicDiff
    const ast = parse(bodyStr);
    let curAst = ast;
    for (let k = 0; k < order; k++) {
      curAst = _simplifyAst(_expandConstSum(_simplifyAst(_symbolicDiff(curAst, varName))));
    }
    return _astToString(curAst);
  }

  // 公开接口: 符号 product (自由变量上界)
  //   输入字符串:  product(变量, 下界, 上界, 表达式)
  //   返回字符串:  化简后的 product 结果, 或 fallback 到符号形式
  //   模式:  1) telescoping A_k/B_k where A_k = B_{k+1}  ->  A(n)/B(m)
  //          2) 几何级数 body = r^k (r 不依赖 k)  ->  r^(sum of indices)
  //          3) 常数 body (与 k 无关)  ->  body^(n-m+1)
  //          4) Fallback:  返回 \prod_{k=m}^{n} (body) 符号形式
  function symbolicProduct(input) {
    if (typeof input !== 'string') throw new Error('symbolicProduct: input must be a string');
    const ast = parse(input);
    if (!ast || ast.type !== 'func' || ast.name !== 'product' || ast.args.length !== 4) {
      throw new Error('symbolicProduct: 期望 product(变量, 下界, 上界, 表达式) 形式');
    }
    const varName = _expectVar(ast.args[0], 'symbolicProduct');
    const fromAst = _simplifyAst(ast.args[1]);
    const toAst   = _simplifyAst(ast.args[2]);
    // ★ 关键: 先把 body 转成"单一分式"形式, 支持 1+1/k -> (k+1)/k
    const bodyAst = _toSingleFraction(_simplifyAst(ast.args[3]), varName);
    const fromVal = _toConstNumber(fromAst);

    // 模式 1: telescoping (body = A/B 且 A = B 中 k -> k+1)
    if (bodyAst && bodyAst.type === 'binop' && bodyAst.op === '/') {
      const A = bodyAst.left, B = bodyAst.right;
      const Bshifted = _substituteVar(B, varName, _newBinop('+', _newVar(varName), _newNum(1)));
      if (_astEqual(A, Bshifted)) {
        // Π_{k=m}^{n} A_k/B_k = A(k=n) / B(k=m)
        const An = _substituteVar(A, varName, toAst);
        const Bm = _substituteVar(B, varName, fromAst);
        // 用字符串直接构造, 避免 _simplifyAst 不充分
        let AnStr = _astToString(_simplifyAst(An));
        let BmStr = _astToString(_simplifyAst(Bm));
        // 漂亮化: n+1 -> 1+n?  不变. 简化掉简单形式
        if (AnStr === '1') return BmStr === '1' ? '1' : '1/' + BmStr;
        if (BmStr === '1') return AnStr;
        return AnStr + '/' + BmStr;
      }
    }

    // 模式 2: 几何级数 body = r^k (r 与 k 无关)
    if (bodyAst && bodyAst.type === 'binop' && bodyAst.op === '^' &&
        bodyAst.right.type === 'var' && bodyAst.right.name === varName &&
        !_dependsOn(bodyAst.left, varName)) {
      // Π_{k=m}^{n} r^k = r^((m+n)(n-m+1)/2)
      // ★ 字符串模板 (避免 _simplifyAst 不充分)
      const toStr = _astToString(toAst);
      const fromStr = _astToString(fromAst);
      const rStr = _astToString(bodyAst.left);
      let countStr, sumStr;
      if (fromVal === 1) {
        countStr = toStr;
        sumStr = '((' + fromStr + '+' + toStr + ')*' + toStr + ')/2';  // (m+n)*n/2
      } else if (fromVal === 0) {
        countStr = '(' + toStr + '+1)';
        sumStr = '((' + fromStr + '+' + toStr + ')*(' + toStr + '+1))/2';
      } else {
        const countAst = _newBinop('-', _newBinop('+', toAst, _newNum(1)), fromAst);
        const countStr2 = _astToString(countAst);
        sumStr = '((' + fromStr + '+' + toStr + ')*' + countStr2 + ')/2';
      }
      return rStr + '^(' + sumStr + ')';
    }

    // 模式 3: body 与 k 无关 -> body^(n-m+1)
    if (bodyAst && !_dependsOn(bodyAst, varName)) {
      const toStr = _astToString(toAst);
      const fromStr = _astToString(fromAst);
      const bodyStr = _astToString(bodyAst);
      let countStr;
      if (fromVal === 1) countStr = toStr;
      else if (fromVal === 0) countStr = '(' + toStr + '+1)';
      else countStr = '(' + toStr + '-' + fromStr + '+1)';
      return bodyStr + '^' + countStr;
    }

    // Fallback
    return '\\prod_{' + varName + '=' + _astToString(fromAst) + '}^{' + _astToString(toAst) + '} (' + _astToString(bodyAst || ast.args[3]) + ')';
  }

  // 公开接口: 符号 sum (自由变量上界)
  //   输入字符串:  sum(变量, 下界, 上界, 表达式)
  //   返回字符串:  化简后的 sum 结果, 或 fallback 到符号形式
  //   模式:  1) 等差级数 body = a*k + b  ->  count * (first + last) / 2
  //          2) 几何级数 body = r^k (r 不依赖 k)  ->  (r^(n+1) - r^m) / (r - 1)
  //          3) 常数 body  ->  body * (n - m + 1)
  //          4) Fallback:  返回 \sum_{k=m}^{n} (body) 符号形式
  function symbolicSum(input) {
    if (typeof input !== 'string') throw new Error('symbolicSum: input must be a string');
    const ast = parse(input);
    if (!ast || ast.type !== 'func' || ast.name !== 'sum' || ast.args.length !== 4) {
      throw new Error('symbolicSum: 期望 sum(变量, 下界, 上界, 表达式) 形式');
    }
    const varName = _expectVar(ast.args[0], 'symbolicSum');
    const fromAst = _simplifyAst(ast.args[1]);
    const toAst   = _simplifyAst(ast.args[2]);
    const bodyAst = _simplifyAst(ast.args[3]);
    const fromVal = _toConstNumber(fromAst);
    const toStr   = _astToString(toAst);
    const fromStr = _astToString(fromAst);

    // ★ 直接处理: body = a*k + b 或 a*k - b (a, b 与 k 无关)
    let aCoef = null, bAst = null, bIsNegated = false;
    if (bodyAst.type === 'binop' && (bodyAst.op === '+' || bodyAst.op === '-')) {
      const left = bodyAst.left, right = bodyAst.right;
      if (left.type === 'binop' && left.op === '*' && !_dependsOn(right, varName)) {
        const k1 = _extractLinearK(left, varName);
        if (k1 !== null) { aCoef = k1.k; bAst = right; bIsNegated = (bodyAst.op === '-'); }
      } else if (right.type === 'binop' && right.op === '*' && !_dependsOn(left, varName)) {
        const k1 = _extractLinearK(right, varName);
        if (k1 !== null) { aCoef = k1.k; bAst = left; bIsNegated = (bodyAst.op === '-'); }
      } else if (left.type === 'var' && left.name === varName && !_dependsOn(right, varName)) {
        aCoef = 1; bAst = right; bIsNegated = (bodyAst.op === '-');
      } else if (right.type === 'var' && right.name === varName && !_dependsOn(left, varName)) {
        aCoef = 1; bAst = left; bIsNegated = (bodyAst.op === '-');
      }
    } else if (bodyAst.type === 'var' && bodyAst.name === varName) {
      aCoef = 1; bAst = _newNum(0);
    } else if (bodyAst.type === 'binop' && bodyAst.op === '*') {
      const k1 = _extractLinearK(bodyAst, varName);
      if (k1 !== null) { aCoef = k1.k; bAst = _newNum(0); }
    } else if (!_dependsOn(bodyAst, varName)) {
      aCoef = 0; bAst = bodyAst;
    }

    if (aCoef !== null) {
      // ★ 字符串模板构造, 避免 _simplifyAst 化简不充分
      let countStr;
      if (fromVal === 1) countStr = toStr;
      else if (fromVal === 0) countStr = '(' + toStr + '+1)';
      else countStr = '(' + toStr + '-' + fromStr + '+1)';

      if (aCoef === 0) {
        // body = b (常数),  sum = b * count
        // 漂亮化: b=1 时直接输出 count, b=-1 时输出 -count
        const bVal2 = _toConstNumber(bAst);
        if (bVal2 === 1) return countStr;
        if (bVal2 === -1) return '-' + countStr;
        const bodyStr = _astToString(bAst);
        return bodyStr + '*' + countStr;
      }

      // ★ 预计算 first/last 并直接生成字符串
      const bVal = _toConstNumber(bAst);
      let first, last;
      if (aCoef === 1 && bVal === 0 && !bIsNegated) {
        // body = k
        if (fromVal !== null) first = String(fromVal); else first = fromStr;
        last = toStr;
      } else if (aCoef === 1 && bVal !== null && !bIsNegated) {
        if (fromVal !== null) first = String(fromVal + bVal); else first = '(' + fromStr + '+' + bVal + ')';
        if (toAst && toAst.type === 'num') last = String(toAst.value + bVal);
        else last = '(' + toStr + '+' + bVal + ')';
      } else if (aCoef === 1 && bVal !== null && bIsNegated) {
        // body = k - b
        if (fromVal !== null) first = String(fromVal - bVal); else first = '(' + fromStr + '-' + bVal + ')';
        if (toAst && toAst.type === 'num') last = String(toAst.value - bVal);
        else last = '(' + toStr + '-' + bVal + ')';
      } else if (aCoef !== null && bVal !== null && !bIsNegated) {
        // body = a*k + b (a != 1, b constant)
        // 优先算常数 (a*m+b), 算不出来再走字符串
        if (fromVal !== null) first = String(aCoef * fromVal + bVal);
        else first = '(' + aCoef + '*' + fromStr + '+' + bVal + ')';
        if (toAst && toAst.type === 'num') last = String(aCoef * toAst.value + bVal);
        else last = '(' + aCoef + '*' + toStr + '+' + bVal + ')';
      } else if (aCoef !== null && bVal !== null && bIsNegated) {
        // body = a*k - b (a != 1)
        if (fromVal !== null) first = String(aCoef * fromVal - bVal);
        else first = '(' + aCoef + '*' + fromStr + '-' + bVal + ')';
        if (toAst && toAst.type === 'num') last = String(aCoef * toAst.value - bVal);
        else last = '(' + aCoef + '*' + toStr + '-' + bVal + ')';
      } else {
        first = '(' + aCoef + '*' + fromStr + '+' + _astToString(bIsNegated ? _newUnary('-', bAst) : bAst) + ')';
        last  = '(' + aCoef + '*' + toStr   + '+' + _astToString(bIsNegated ? _newUnary('-', bAst) : bAst) + ')';
      }
      // sum = count * (first + last) / 2
      const exprStr = countStr + '*(' + first + '+' + last + ')/2';
      // 解析 + 化简 (处理 n*((2*n+1)+3)/2 -> 化简形式)
      try {
        const ast = parse(exprStr);
        return _astToString(_simplifyAst(ast));
      } catch (e) {
        return exprStr;
      }
    }

    // 模式 2: 几何级数 body = r^k (r 与 k 无关)
    if (bodyAst.type === 'binop' && bodyAst.op === '^' &&
        bodyAst.right.type === 'var' && bodyAst.right.name === varName &&
        !_dependsOn(bodyAst.left, varName)) {
      // Σ_{k=m}^{n} r^k = (r^(n+1) - r^m) / (r - 1)  for r != 1
      const rStr = _astToString(bodyAst.left);
      const exprStr = '(' + rStr + '^(' + toStr + '+1)-' + rStr + '^' + fromStr + ')/(' + rStr + '-1)';
      // 解析 + 化简 (去掉 (2-1)=1 之类)
      try {
        const ast = parse(exprStr);
        return _astToString(_simplifyAst(ast));
      } catch (e) {
        return exprStr;
      }
    }

    // 模式 4: ★ r5 二项式定理  body = binom(n,k) * r^k  (r 与 k 无关, 上界 = binom 第一参 = toStr)
    //   经典恒等式:  Σ_{k=0}^{n} C(n,k) * r^k = (1+r)^n
    //   也支持隐式 r=1:  body = binom(n,k)
    //   检查 bodyAst 是 binom(n,k) 形式 (n 必须等于 toStr, k 必须等于 varName)
    if (toAst.type === 'var' && bodyAst.type === 'func' && bodyAst.name === 'binom' &&
        bodyAst.args.length === 2 && bodyAst.args[0].type === 'var' &&
        bodyAst.args[0].name === toAst.name && bodyAst.args[1].type === 'var' &&
        bodyAst.args[1].name === varName) {
      // body = binom(n, k) 其中 n == toStr, k == varName
      // r=1 隐式:  sum = (1+1)^n = 2^n
      const exprStr = '(1+1)^' + toStr;
      try {
        const ast = parse(exprStr);
        return _astToString(_simplifyAst(ast));
      } catch (e) {
        return exprStr;
      }
    }
    // body = binom(n,k) * r^k 形式 (外层是 *, 至少一边是 binom)
    if (toAst.type === 'var' && bodyAst.type === 'binop' && bodyAst.op === '*') {
      // 尝试两边找出 binom(n,k)
      const leftBinom  = (bodyAst.left.type === 'func' && bodyAst.left.name === 'binom') ? bodyAst.left : null;
      const rightBinom = (bodyAst.right.type === 'func' && bodyAst.right.name === 'binom') ? bodyAst.right : null;
      const binomNode  = leftBinom || rightBinom;
      const rNode      = leftBinom ? bodyAst.right : bodyAst.left;
      if (binomNode && binomNode.args.length === 2 &&
          binomNode.args[0].type === 'var' && binomNode.args[0].name === toAst.name &&
          binomNode.args[1].type === 'var' && binomNode.args[1].name === varName) {
        // 检查 r^k: r 与 k 无关, 形如 r^k
        let rBase = null;
        if (rNode.type === 'binop' && rNode.op === '^' && rNode.right.type === 'var' &&
            rNode.right.name === varName && !_dependsOn(rNode.left, varName)) {
          rBase = rNode.left;
        } else if (!_dependsOn(rNode, varName)) {
          rBase = rNode;  // 常数 r
        }
        if (rBase !== null) {
          // sum = (1+r)^n
          const rStr = _astToString(rBase);
          const exprStr = '(1+' + rStr + ')^' + toStr;
          try {
            const ast = parse(exprStr);
            return _astToString(_simplifyAst(ast));
          } catch (e) {
            return exprStr;
          }
        }
      }
    }

    // Fallback
    return '\\sum_{' + varName + '=' + fromStr + '}^{' + toStr + '} (' + _astToString(bodyAst) + ')';
  }

  // 把表达式转成单一分式 (a/b) 用于 telescoping 检测
  //   1+1/k -> (k+1)/k,  (a+b/c)/d -> (ad+bc)/(cd), 等
  //   如果不能转成分式, 返回原 AST
  function _toSingleFraction(body, varName) {
    if (!body) return body;
    if (body.type === 'binop' && body.op === '/') return body;
    if (body.type === 'binop' && (body.op === '+' || body.op === '-')) {
      // 尝试把左右两边都转成分式, 然后合成
      const A = _toSingleFraction(body.left, varName);
      const B = _toSingleFraction(body.right, varName);
      if (A && B && A.type === 'binop' && A.op === '/' && B.type === 'binop' && B.op === '/') {
        // A = A1/A2, B = B1/B2
        // A + B = (A1*B2 + B1*A2) / (A2*B2)
        // A - B = (A1*B2 - B1*A2) / (A2*B2)
        const newNum = body.op === '+'
          ? _newBinop('+', _newBinop('*', A.left, B.right), _newBinop('*', B.left, A.right))
          : _newBinop('-', _newBinop('*', A.left, B.right), _newBinop('*', B.left, A.right));
        const newDen = _newBinop('*', A.right, B.right);
        return _simplifyAst(_newBinop('/', newNum, newDen));
      }
    }
    // 1 + 1/k 形式: 如果 body 是 1 + fraction, 转成分式
    if (body.type === 'binop' && body.op === '+' && body.left.type === 'num' && body.left.value === 1) {
      const right = _toSingleFraction(body.right, varName);
      if (right && right.type === 'binop' && right.op === '/') {
        // 1 + a/b = (b + a) / b
        const newNum = _newBinop('+', right.right, right.left);
        return _newBinop('/', newNum, right.right);
      }
    }
    return body;
  }

  // AST 结构等价 (用于 telescoping 检测)
  //   对 + 和 * 操作数, 支持交换律重排后再比较
  function _astEqual(a, b) {
    if (!a || !b) return a === b;
    if (a.type !== b.type) return false;
    if (a.type === 'num') return a.value === b.value;
    if (a.type === 'var') return a.name === b.name;
    if (a.type === 'unary') return a.op === b.op && _astEqual(a.operand, b.operand);
    if (a.type === 'binop') {
      if (a.op !== b.op) return false;
      if (_astEqual(a.left, b.left) && _astEqual(a.right, b.right)) return true;
      // ★ 交换律: 对 + 和 *, 左右可交换
      if ((a.op === '+' || a.op === '*') && _astEqual(a.left, b.right) && _astEqual(a.right, b.left)) return true;
      return false;
    }
    if (a.type === 'func') return a.name === b.name && a.args.length === b.args.length && a.args.every((x, i) => _astEqual(x, b.args[i]));
    return false;
  }

  // 数值积分:  integrate(表达式, 变量, 下界, 上界)
  //   - 自适应 Simpson, 递归深度上限 50, 终止容差 1e-12
  //   - 区间过大 (|b-a| > 1e9) 会按子区间分段 (每段 1e6) 再相加
  //   - ★ r8: 奇异端点处理 - f(a) 或 f(b) 是 ±inf/NaN 时, 用 a+eps / b-eps 替代, 跳过发散端点
  //     (∫_0^1 x·ln(x) dx, ∫_0^1 ln(x) dx 等下界/上界是 singular 的可积积分)
  //   - ★ r10: 上下界是无穷 (Infinity / -Infinity) -> 抛 __INTEGRATE_INF__ 错误
  //     让 bot catch 后调 integrateAsync (走 Python mpmath.quad, 原生支持无穷界)
  //     (∫_0^∞ x^2 e^(-3x) dx = 2/27, ∫_{-∞}^∞ e^(-x^2) dx = √π 等)
  //     marker 格式: __INTEGRATE_INF__:<varName>:<aStr>:<bStr>:<encodedBody>
  function _evalIntegrate(args, baseVars) {
    if (args.length !== 4) throw new Error('integrate() 需要 4 个参数: integrate(表达式, 变量, 下界, 上界)');
    const exprAst = args[0];
    const varName = _expectVar(args[1], 'integrate');
    const a = _toNum(evaluateAst(args[2], baseVars));
    const b = _toNum(evaluateAst(args[3], baseVars));
    // ★ r10: 无穷界 (a 或 b 是 ±Infinity) 抛 __INTEGRATE_INF__ 让 bot 路由到 Python mpmath.quad
    if (a === Infinity || a === -Infinity || b === Infinity || b === -Infinity) {
      const bodyStr = _astToString(exprAst);
      const aStr = String(a);  // 'Infinity' / '-Infinity' / 数字字符串
      const bStr = String(b);
      throw new Error('__INTEGRATE_INF__:' + varName + ':' + aStr + ':' + bStr + ':' + encodeURIComponent(bodyStr));
    }
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      throw new Error('integrate() 上下界必须是有限数');
    }

    function f(x) {
      const vars = Object.assign({}, baseVars);
      vars[varName] = x;
      return evaluateAst(exprAst, vars);
    }

    // ★ r8: 奇异端点自动收缩. fa0/fb0 是有限数就不动, 否则用 eps 替代
    let aAdj = a, bAdj = b;
    let fa0 = f(a), fb0 = f(b);
    const needAdjustA = !Number.isFinite(fa0);
    const needAdjustB = !Number.isFinite(fb0);
    if (needAdjustA) {
      const epsA = Math.max(1e-12, Math.abs(b - a) * 1e-10);
      aAdj = a + epsA;
      // 重新算 fa0 给 Simpson 入口用, 避免再调 f(a)
      fa0 = f(aAdj);
    }
    if (needAdjustB) {
      const epsB = Math.max(1e-12, Math.abs(b - a) * 1e-10);
      bAdj = b - epsB;
      fb0 = f(bAdj);
    }

    // 区间太宽分段求和 (避免单次递归深度/精度问题)
    const MAX_SEG = 1e6;
    function _doSimpson(a0, b0) {
      if (Math.abs(b0 - a0) <= MAX_SEG) {
        const r = _adaptiveSimpson(f, a0, b0, 1e-12, 50);
        return Math.abs(r) < 1e-15 ? 0 : r;
      }
      const N = Math.ceil(Math.abs(b0 - a0) / MAX_SEG);
      const step = (b0 - a0) / N;
      let total = 0;
      for (let i = 0; i < N; i++) {
        const segA = a0 + i * step;
        const segB = segA + step;
        try { total += _adaptiveSimpson(f, segA, segB, 1e-9, 30); }
        catch (e) { /* 单段失败跳过, 留给主段平均 */ }
      }
      return total;
    }

    if (!needAdjustA && !needAdjustB) {
      return _doSimpson(a, b);
    }
    // 奇异端点: 主段 [aAdj, bAdj], 奇异首尾各补一段小区间
    //   左奇异段: f 在 [a, aAdj] 上是 singular, 但 lim_{x->a+} f(x) 通常有限
    //     例如 x·ln(x) 在 x=0 极限 = 0, ln(x) 在 x=0 极限 = -inf
    //   简单方案: 跳过 singular 段 (假定贡献 0)
    return _doSimpson(aAdj, bAdj);
  }

  // 数值极限:  limit(表达式, 变量, 趋近点[, 方向])
  //   - 从两侧用 h = 1e-1, 1e-2, ..., 1e-10 趋近
  //   - 两侧都有限且差 < 1e-6  →  返回均值
  //   - 一侧发散 / 两侧不同    →  返回最稳定的单侧值 (右侧优先) 或 NaN
  //   - 趋近点为 ±∞ 时用大数 1e10 替代
  //   ★ r11: 第 4 参数 direction (-1=左极限 / 0=双侧默认 / +1=右极限)
  //     用于支持 LaTeX `\lim_{x \to a^+}` / `\lim_{x \to a^-}` 单侧极限
  //     3-arg 调用 (旧行为) 仍走双侧
  function _evalLimit(args, baseVars) {
    if (args.length !== 3 && args.length !== 4) {
      throw new Error('limit() 需要 3 或 4 个参数: limit(表达式, 变量, 趋近点[, 方向])');
    }
    const exprAst = args[0];
    const varName = _expectVar(args[1], 'limit');
    const pointRaw = evaluateAst(args[2], baseVars);
    const point = _toNum(pointRaw);

    // ★ r11: 解析 direction (第 4 参数)
    let direction = 0;
    if (args.length === 4) {
      const dirRaw = evaluateAst(args[3], baseVars);
      const dir = _toNum(dirRaw);
      if (dir === 1) direction = 1;
      else if (dir === -1) direction = -1;
      else if (dir === 0) direction = 0;
      else throw new Error('limit() direction 必须是 -1 (左), 0 (双), +1 (右), 实际: ' + dir);
    }

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
    // ★ 当 h 极小时, f 可能因底层算法精度限制返回 0 或乱码, 导致 Aitken 退化
    //   例: ∫t³ dt 在 x<1e-4 时 Simpson 给出 0; lim(∫t³/x⁴) 会看到 [1/4, 1/4, 1/4, 0, 0, ...]
    //   改用 ★ 尾段稳态检测: 从后往前找连续稳定值, 用 Aitken 推一个更快收敛
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
    // ★ r11: 单侧模式 - 只检查对应侧是否有数据
    if (direction === 1) {
      if (right.length === 0) return NaN;
    } else if (direction === -1) {
      if (left.length === 0) return NaN;
    } else {
      if (left.length === 0 && right.length === 0) return NaN;
    }

    // ★ r11-amend: 发散检测 - 序列 |v| 单调增长且超过阈值 → 返回 ±Infinity
    //   思路: 序列最后 N 个值, 绝对值 > 1e3, 且严格单调 (|v_{i+1}| > |v_i|), 判为发散
    //   适用: lim(1/x, x, 0, +1) = +∞, lim(1/x, x, 0, -1) = -∞, lim(1/x^2, x, 0, ±) = +∞
    //   不适用: 1^∞ 极限 (被前面特判拦截), 收敛极限 (|v| 单调减)
    function detectDivergence(seq) {
      if (seq.length < 3) return null;
      // 取最后 10 个点 (或全部, 不足 10 个就全要). h=2^-n, 取最后 10 个覆盖 h≈2^-10..2^-19
      //   对 1/x at 0: v 范围 1024..524288, 单调 2 倍增
      const tail = seq.slice(-10);
      // 检查严格单调:  |v[i+1]| > |v[i]|  且  v 同号
      let allPos = true, allNeg = true, growing = true;
      for (let i = 0; i < tail.length - 1; i++) {
        if (tail[i] <= 0) allPos = false;
        if (tail[i] >= 0) allNeg = false;
        if (Math.abs(tail[i + 1]) <= Math.abs(tail[i]) * 1.2) growing = false;
        // 至少 1.2 倍增长才算发散, 避免抖动
      }
      if (!growing) return null;
      // 至少一个值 |v| > 1e3 (确保不是数值误差)
      const maxAbs = Math.max(...tail.map(Math.abs));
      if (maxAbs < 1e3) return null;
      if (allPos) return Infinity;
      if (allNeg) return -Infinity;
      return null;
    }
    // ★ r11-amend: 单侧发散检测
    if (direction === 1) {
      const div = detectDivergence(right);
      if (div !== null) return div;
    } else if (direction === -1) {
      const div = detectDivergence(left);
      if (div !== null) return div;
    } else {
      // 双侧: 一侧发散 (另一侧有限 / 也发散同号) 才返回 ±∞
      const divL = detectDivergence(left);
      const divR = detectDivergence(right);
      if (divL === Infinity && divR === Infinity) return Infinity;
      if (divL === -Infinity && divR === -Infinity) return -Infinity;
      // 一侧发散一侧不发散: 仍走 Aitken 路径 (e.g. lim(1/x, x, 0) NaN, 这是数学上 DNE)
    }

    // ★ 找稳定段: 从后往前, 跳过 "明显被精度污染" 的尾部 0 / 异常值
    //   思路: 找到最长的连续段, 其中值之间相对差 < 1e-3
    //   例: [1/3, 1/3, 1/3, 1/3, 0.311, 0, 0, 0] -> 稳定段 [1/3, 1/3, 1/3, 1/3] (前 4 个)
    function findStableSeq(seq) {
      if (seq.length <= 3) return seq;
      // 从索引 i 开始, 找到最长的稳定段
      let bestStart = 0, bestLen = 1;
      for (let i = 0; i < seq.length; i++) {
        let j = i;
        while (j + 1 < seq.length) {
          const ref = Math.max(1e-30, Math.abs(seq[j]));
          if (Math.abs(seq[j+1] - seq[j]) <= 1e-3 * ref) j++;
          else break;
        }
        if (j - i + 1 > bestLen) {
          bestLen = j - i + 1;
          bestStart = i;
        }
      }
      return seq.slice(bestStart, bestStart + bestLen);
    }
    // ★ r11: 单侧模式 - 不参与的一侧留空数组, findStableSeq 返回空 (处理空数组的边界)
    const leftStable  = (direction === 1)  ? [] : findStableSeq(left);
    const rightStable = (direction === -1) ? [] : findStableSeq(right);

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
    const aL = leftStable.length  >= 3 ? aitken(leftStable)  : (leftStable.length  ? leftStable[leftStable.length - 1]  : NaN);
    const aR = rightStable.length >= 3 ? aitken(rightStable) : (rightStable.length ? rightStable[rightStable.length - 1] : NaN);

    // ★ r11: 单侧模式 - 直接返回对应侧, 不做均值
    if (direction === 1) {
      return Number.isFinite(aR) ? aR : NaN;
    }
    if (direction === -1) {
      return Number.isFinite(aL) ? aL : NaN;
    }

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
        if (ast.name === 'symbolicIntegrate') {
          // 不定积分: 返回反导函数表达式字符串 (含 +C)
          const exprStr = _astToString(ast.args[0]);
          const varStr  = ast.args[1] && ast.args[1].type === 'var' ? ast.args[1].name : String(ast.args[1]);
          return symbolicIntegrate(exprStr, varStr);
        }

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
    let maxChange = 0;  // ★ r15-amend9 Bug 7.1: 提升到循环外, 便于循环后检查收敛
    for (let iter = 0; iter < MAX_ITER; iter++) {
      maxChange = 0;
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

    // ★ r15-amend9 Bug 7.1: 60 次迭代未收敛时 console.warn (不抛错避免破坏现有行为)
    if (maxChange >= TOL) {
      console.warn('Aberth-Ehrlich did not converge: maxChange=' + maxChange + ' (TOL=' + TOL + ')');
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
        // ★ r15-amend9 Bug 5.2: vars 含 BigInt 时 JSON.stringify 抛 TypeError, 用 replacer 转 string
        body: JSON.stringify(body, function (k, v) { return typeof v === 'bigint' ? v.toString() : v; }),
        signal: controller ? controller.signal : undefined
      });
      if (!r.ok) {
        // ★ r15-amend6: 提取响应体中的 error 字段, 让 bot 能显示 Python 端的真实错误
        //   (例如 "nsum divergent series: ..."), 而不是无信息的 "HTTP 400"
        let errBody = '';
        try { errBody = await r.text(); } catch (_) {}
        let errMsg = 'Python backend HTTP ' + r.status;
        if (errBody) {
          try {
            const parsed = JSON.parse(errBody);
            if (parsed && parsed.error) errMsg = 'Python backend: ' + parsed.error.split('\n')[0];
          } catch (_) { errMsg += ' (' + errBody.substring(0, 200) + ')'; }
        }
        throw new Error(errMsg);
      }
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

  // -----------------------------------------------------------------------
  // LaTeX 输入解析
  // -----------------------------------------------------------------------
  // 支持子集:
  //   \frac{a}{b}  \dfrac{a}{b}        -> (a)/(b)
  //   \sqrt{x}  \sqrt[n]{x}            -> sqrt(x) / (x)^(1/n)
  //   \sum_{i=1}^{n} expr              -> sum(i,1,n,expr)
  //   \prod_{i=1}^{n} expr             -> product(i,1,n,expr)
  //   \int_a^b expr  (x 隐含)          -> integrate(expr, x, a, b)
  //   \int_a^b expr dx                 -> integrate(expr, x, a, b)
  //   \lim_{x \to a} expr              -> limit(expr, x, a)
  //   希腊字母  \pi  \alpha  \theta ... -> pi  alpha  theta ...
  //   \infty                           -> inf
  //   \cdot  \times  \div  \pm  \mp    -> *  *  /  +  -
  //   \leq  \geq  \neq  \approx        -> <=  >=  !=  ~=
  //   三角对数 \sin \cos \tan \log \ln \exp \arcsin \arccos \arctan \sinh \cosh \tanh
  //   空白  \,  \;  \:  \!  ~  空格    -> 删除
  //   x^{2}  x_{2}                    -> x^(2) / x (下标删除)
  // 不支持: 矩阵, 方程式, 复杂 LaTeX 排版, 自定义宏
  // LaTeX 解析 (有状态, 用全局 pos 指针)
  //   支持: \frac \sqrt \sum \prod \int \lim, 希腊字母, 运算符, 三角函数
  //   \sin \cos \tan \log \ln \exp, 空白符, 上下标 ^_{}
  function parseLatex(input) {
    if (typeof input !== 'string') return input;
    if (input.indexOf('\\') < 0 && input.indexOf('^') < 0 && input.indexOf('_') < 0
        && input.indexOf('{') < 0 && input.indexOf('}') < 0) {
      return input;   // 没有 LaTeX 标记, 原样返回
    }

    // 让 src 可变, 以便 processCommand 内部能裁剪 (如 \int 末尾的 dx)
    let src = input;
    let pos = 0;
    const placeholders = [];   // 占位符回填表

    // 裸函数名白名单 (LaTeX 里写 sin 而不是 \sin, 也视作函数调用)
    const _LATEX_BARE_FUNCS = new Set([
      'sin','cos','tan','csc','sec','cot',
      'asin','acos','atan','arcsin','arccos','arctan',
      'sinh','cosh','tanh',
      'ln','log','log2','exp','sqrt','cbrt',
      'abs','round','floor','ceil','min','max',
      'det','arg','mod','sign',
      'sum','product','diff','integrate','limit',
      'symbolicDiff','symbolicIntegrate',
      // ★ r5: 二项式系数
      'binom','tbinom','dbinom'
    ]);

    // 读取 src 剩余的全部内容, 递归 parseLatex 处理 (含嵌套的 \frac, \sum 等)
    //   如果末尾是 bot 的求导请求 (for f'(x)/for f''/for f'''(x)), 在 for 之前停下
    //   返回 { body, suffix }: body 是 LaTeX 转换结果, suffix 是末尾的 " for f'(x)" 原样保留
    //   这样 \prod\int\sum 后的 LaTeX body 不会吞掉 "for f'(x)" 这种求导请求
    function readBodyToEnd() {
      skipWs();
      if (pos >= src.length) return { body: '', suffix: '' };
      const rest = src.slice(pos);
      // 匹配末尾的求导请求: "...  for  <ident>('+)(  (ident)  )?"
      const forMatch = rest.match(/^(.*?)\s+for\s+([A-Za-z_]\w*)('{1,})(?:\s*\(\s*[A-Za-z_]\w*\s*\))?\s*$/);
      if (forMatch && forMatch[1].length > 0) {
        const bodyEnd = forMatch[1].length;
        const suffix = rest.slice(bodyEnd);
        pos = pos + rest.length;
        return { body: parseLatex(rest.slice(0, bodyEnd)), suffix: suffix };
      }
      pos = pos + rest.length;
      return { body: parseLatex(rest), suffix: '' };
    }

    // 类似 readBodyToEnd, 但在顶层 + 或 - 处停下 (sum/product 专用)
    //   - 跳过 {…}, (…), \command, 单字符 的内部
    //   - 遇到 src[pos] 为 + 或 - 且不在上述内部时, 停下
    //   末尾是 "for f'(x)" 求导请求时也停下
    function readSumBodyToEnd() {
      skipWs();
      if (pos >= src.length) return { body: '', suffix: '' };
      const startPos = pos;
      // 先尝试匹配末尾的 forDeriv (避免吃掉求导请求)
      const rest = src.slice(pos);
      const forMatch = rest.match(/^(.*?)\s+for\s+([A-Za-z_]\w*)('{1,})(?:\s*\(\s*[A-Za-z_]\w*\s*\))?\s*$/);
      let endPos = src.length;
      let suffix = '';
      if (forMatch && forMatch[1].length > 0) {
        endPos = pos + forMatch[1].length;
        suffix = rest.slice(forMatch[1].length);
      }
      // 在 [pos, endPos) 区间找顶层 + 或 -
      let depthBrace = 0, depthParen = 0, depthCmd = 0;
      // depthCmd: 用于追踪 \command 内部正在 readBraced/readArg 的层数, 简化处理
      let p = pos;
      while (p < endPos) {
        const c = src[p];
        if (c === '\\' && p + 1 < endPos) {
          // 跳过整个 \command 包括其参数, 用 processCommand 处理
          const savePos = p; p++;
          let m = src.slice(p).match(/^[A-Za-z]+/);
          if (m) p += m[0].length;
          else p++;   // 单字符命令
          // ★ Bug 55: \left( / \right) 需要跟踪括号深度, 否则 \left(...\right) 内的 +/- 会被误判为顶层
          if (m && (m[0] === 'left' || m[0] === 'LEFT')) {
            while (p < endPos && /\s/.test(src[p])) p++;
            if (p < endPos) {
              const b = src[p];
              if (b === '(' || b === '[') { depthParen++; p++; continue; }
              if (b === '{') { depthBrace++; p++; continue; }
              p++; continue;  // \left| 或 \left. 不影响深度
            }
            continue;
          }
          if (m && (m[0] === 'right' || m[0] === 'RIGHT')) {
            while (p < endPos && /\s/.test(src[p])) p++;
            if (p < endPos) {
              const b = src[p];
              if (b === ')' || b === ']') { depthParen--; p++; continue; }
              if (b === '}') { depthBrace--; p++; continue; }
              p++; continue;  // \right| 或 \right. 不影响深度
            }
            continue;
          }
          // 跳过命令后的可选参数
          while (p < endPos) {
            while (p < endPos && /\s/.test(src[p])) p++;
            if (p < endPos && src[p] === '\\' && p + 1 < endPos && /[,;:\!]/.test(src[p + 1])) { p += 2; continue; }
            if (p < endPos && src[p] === '{') {
              // 读平衡 {…}
              let d = 1; p++;
              while (p < endPos && d > 0) {
                if (src[p] === '{') d++;
                else if (src[p] === '}') d--;
                p++;
              }
              continue;
            }
            if (p < endPos && src[p] === '_' && p + 1 < endPos && src[p + 1] === '{') {
              p += 2;
              let d = 1;
              while (p < endPos && d > 0) {
                if (src[p] === '{') d++;
                else if (src[p] === '}') d--;
                p++;
              }
              continue;
            }
            if (p < endPos && src[p] === '^' && p + 1 < endPos && src[p + 1] === '{') {
              p += 2;
              let d = 1;
              while (p < endPos && d > 0) {
                if (src[p] === '{') d++;
                else if (src[p] === '}') d--;
                p++;
              }
              continue;
            }
            if (p < endPos && /[A-Za-z(]/.test(src[p])) { p++; continue; }   // 函数参数: 单字符或 (…)
            break;
          }
          continue;
        }
        if (c === '{') { depthBrace++; p++; continue; }
        if (c === '}') { depthBrace--; p++; continue; }
        if (c === '(') { depthParen++; p++; continue; }
        if (c === ')') { depthParen--; p++; continue; }
        if (depthBrace === 0 && depthParen === 0 && (c === '+' || c === '-')) {
          // 停下
          break;
        }
        p++;
      }
      const bodyStr = src.slice(pos, p);
      pos = Math.min(p, endPos);  // 推进 pos, 但不越过 forDeriv 边界
      if (pos < startPos + endPos - pos && forMatch) {
        // 还需要再跳到 endPos (for 之前)
        pos = endPos;
      }
      return { body: parseLatex(bodyStr), suffix: suffix };
    }

    // 在 src 末尾剥离可选的 (空白/\,)* d<letter> (即 \int 的 dx), 返回 varName 或 null
    function stripTrailingDx() {
      // 匹配 (空白/\\,|\\;|\\:|\\!|\\,)* d<letter> 在末尾
      const tail = src.slice(pos);
      const re = /(?:[\s]|(?:\\[,\;:\!]))*d([A-Za-z])\s*$/;
      const mm = tail.match(re);
      if (mm) {
        // 裁剪 src (从末尾移除 dx 部分)
        src = src.slice(0, src.length - mm[0].length);
        return mm[1];
      }
      return null;
    }

    function pushPlaceholder(body) {
      const id = placeholders.length;
      placeholders.push(body);
      return '\x01' + id + '\x02';
    }

    // 跳过空白
    function skipWs() {
      while (pos < src.length && /\s/.test(src[pos])) pos++;
    }

    // 读一个平衡表达式: 以 [{, (, [ 开始, 找匹配的 }, ), ] 结束
    //   用于 \dfrac{d}{dx} <expr> 后面的 <expr> 部分
    function readBalancedExpr() {
      skipWs();
      if (pos >= src.length) return null;
      const c = src[pos];
      let openChar, closeChar, depthStart;
      if (c === '{') { openChar = '{'; closeChar = '}'; depthStart = 1; }
      else if (c === '(') { openChar = '('; closeChar = ')'; depthStart = 1; }
      else if (c === '[') { openChar = '['; closeChar = ']'; depthStart = 1; }
      else {
        // 裸表达式: 读到第一个空格/结束/未配对字符为止
        const start = pos;
        while (pos < src.length && !/[\s,;+\-*/^]/.test(src[pos])) pos++;
        if (pos === start) return null;
        return src.slice(start, pos);
      }
      pos++;  // 跳过 openChar
      const start = pos;
      let depth = depthStart;
      while (pos < src.length && depth > 0) {
        if (src[pos] === openChar) depth++;
        else if (src[pos] === closeChar) depth--;
        pos++;
      }
      if (depth !== 0) return null;
      return src.slice(start, pos - 1);
    }

    // 读取命令名 (字母序列, 或单个非字母字符)
    function readCmd() {
      // 先试字母命令 (\alpha, \frac, ...)
      const m = src.slice(pos + 1).match(/^[A-Za-z]+/);
      if (m) {
        pos += 1 + m[0].length;
        return m[0];
      }
      // 再试单字符命令 (\,, \;, \(, \), \$, \#, \%, \&, \\, ...)
      if (pos + 1 < src.length) {
        const c = src[pos + 1];
        pos += 2;
        return c;
      }
      return null;
    }

    // 读取平衡的 {…} (必须以 { 开头, 包含嵌套). 返回内容字符串; 失败返回 null
    function readBraced() {
      skipWs();
      if (src[pos] !== '{') return null;
      const start = pos;
      let depth = 1, j = pos + 1;
      while (j < src.length && depth > 0) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') depth--;
        j++;
      }
      if (depth !== 0) return null;
      const inner = src.slice(start + 1, j - 1);
      pos = j;
      return inner;
    }

    // 读取 _/^ 后的参数: {…} 或 单字符
    function readScriptArg() {
      skipWs();
      if (pos >= src.length) return null;
      if (src[pos] === '{') return readBraced();
      const ch = src[pos]; pos++;
      return ch;
    }

    // ★ r9: 在 startPos 位置读一个函数参数 ({...} / (...) / letter[^{n}]*)
    //   返回 { arg, advanceTo } 或 null
    //   - 跳过起始空白
    //   - {...} 走 readBraced + parseLatex
    //   - (...) 走平衡块 + parseLatex
    //   - 单 letter 走 readScriptArg 循环 (允许 letter^2 形式)
    function _readFuncArg(startPos) {
      let p = startPos;
      while (p < src.length && /\s/.test(src[p])) p++;
      if (p >= src.length) return null;
      if (src[p] === '{') {
        const savePos = pos; pos = p;
        const inner = readBraced();
        const advanceTo = pos;
        pos = savePos;
        if (inner === null) return null;
        return { arg: parseLatex(inner), advanceTo };
      } else if (src[p] === '(') {
        let depth = 1, j = p + 1;
        while (j < src.length && depth > 0) {
          if (src[j] === '(') depth++;
          else if (src[j] === ')') depth--;
          j++;
        }
        if (depth !== 0) return null;
        const inner = src.slice(p + 1, j - 1);
        return { arg: parseLatex(inner), advanceTo: j };
      } else if (/[A-Za-z]/.test(src[p])) {
        let arg = src[p];
        let advanceTo = p + 1;
        while (advanceTo < src.length && src[advanceTo] === '^') {
          const savePos = pos; pos = advanceTo + 1;
          const a = readScriptArg();
          if (a === null) { pos = savePos; break; }
          arg = arg + '^(' + parseLatex(a) + ')';
          advanceTo = pos;
          pos = savePos;
        }
        return { arg, advanceTo };
      }
      return null;
    }

    // ★ r15-amend4: 扫一个 "bare atom" (数字/字母/`.` 序列 + 可选 ^/_ 脚本 + \atomic)
    //   用于 \func 命令后跟 \cos 2x / \sin 3x / \ln 2x / \cos \pi 等 arg
    //   返回 { str, end } 或 null (没有可扫的 atom)
    //   终止条件: 空白 / 运算符 / 边界字符 (+-*/\(){}  , ; = < > | & ! : ' " 等)
    //   注: 只 consume 原子 \command (希腊字母 + \infty \partial \nabla),
    //       函数式 \command (\cos \sin \log \frac \sqrt 等) 视为边界, 不 consume.
    //       这样 \cos 2x\cos 3x 第二个 \cos 不会被吃进第一个 arg
    const _ATOMIC_LATEX_CMDS = {
      'alpha':1,'beta':1,'gamma':1,'delta':1,'epsilon':1,'varepsilon':1,'zeta':1,'eta':1,
      'theta':1,'vartheta':1,'iota':1,'kappa':1,'lambda':1,'mu':1,'nu':1,'xi':1,
      'pi':1,
      'rho':1,'sigma':1,'varsigma':1,'tau':1,'upsilon':1,'phi':1,'varphi':1,'chi':1,
      'psi':1,'omega':1,
      'Gamma':1,'Delta':1,'Theta':1,'Lambda':1,'Xi':1,'Pi':1,'Sigma':1,
      'Upsilon':1,'Phi':1,'Psi':1,'Omega':1,
      'infty':1,'partial':1,'nabla':1
    };
    function _readBareAtom(startPos) {
      let q = startPos;
      // 跳过空白
      while (q < src.length && (src[q] === ' ' || src[q] === '\t')) q++;
      if (q >= src.length) return null;
      // 必须以字母/数字/\ 开头
      if (!/[A-Za-z0-9\\]/.test(src[q])) return null;
      const start = q;
      while (q < src.length) {
        const c = src[q];
        if (c >= 'A' && c <= 'Z') q++;
        else if (c >= 'a' && c <= 'z') q++;
        else if (c >= '0' && c <= '9') q++;
        else if (c === '.') q++;  // 数字小数点
        else if (c === '_') q++;  // 名字里的下划线
        else if (c === '^' || c === '_') {
          // 读脚本: {…} 平衡块 或 单字符
          q++;
          while (q < src.length && (src[q] === ' ' || src[q] === '\t')) q++;
          if (q >= src.length) break;
          if (src[q] === '{') {
            let depth = 1; q++;
            while (q < src.length && depth > 0) {
              if (src[q] === '{') depth++;
              else if (src[q] === '}') depth--;
              q++;
            }
            if (depth !== 0) return null;
          } else if (/[A-Za-z0-9]/.test(src[q])) {
            q++;
          } else {
            q--;
            break;
          }
        }
        else if (c === '\\') {
          // \command: 只 consume 原子 command (希腊字母, \infty 等)
          //   函數式 command (\cos, \sin, \frac 等) 視為邊界, 不 consume
          q++;
          // 单字符命令 (e.g. \, \; \! 等): 消耗
          if (q < src.length && !/[A-Za-z]/.test(src[q])) {
            continue;
          }
          // 多字符命令: 读出名字
          const cmdStart = q;
          while (q < src.length && /[A-Za-z]/.test(src[q])) q++;
          const cmdName = src.slice(cmdStart, q);
          if (_ATOMIC_LATEX_CMDS[cmdName]) {
            // 原子命令 (希腊字母等), 继续扫
            continue;
          }
          // 函數式 command (cos, sin, frac, sqrt 等), 回退: 把 \command 留在外面
          q = cmdStart - 1;  // 回退到 \ 之前
          break;
        }
        else {
          // 其它字符: 边界, 终止
          break;
        }
      }
      return { str: src.slice(start, q), end: q };
    }

    // 读取一个参数: {…} 或 \command… 或 (...) 或 单字符
    //   返回的是已 parseLatex 过的字符串 (除单字符外都递归)
    function readArg() {
      skipWs();
      if (pos >= src.length) return null;
      const c = src[pos];
      let result;
      if (c === '{') {
        const inner = readBraced();
        if (inner === null) return null;
        result = parseLatex(inner);
      } else if (c === '\\') {
        const r = processCommand();
        if (r === null) return null;
        result = r.text;
      } else if (c === '(') {
        // 读平衡 (...) 块, 用内部内容递归
        pos++;
        let depth = 1, j = pos;
        while (j < src.length && depth > 0) {
          if (src[j] === '(') depth++;
          else if (src[j] === ')') depth--;
          j++;
        }
        if (depth !== 0) return null;
        const inner = src.slice(pos, j - 1);
        pos = j;
        result = parseLatex(inner);
      } else {
        pos++;
        result = c;
      }
      // 消耗尾随的 ^ 和 _ 脚本 (把 x^2 当成一个 token)
      while (pos < src.length && (src[pos] === '^' || src[pos] === '_')) {
        const sc = src[pos]; pos++;
        skipWs();
        const a = readScriptArg();
        if (a === null) break;
        if (sc === '^') result = result + '^(' + parseLatex(a) + ')';
        // 下标直接丢弃
      }
      return result;
    }

    // 处理一个 \command, 返回 { text } 或 null
    function processCommand() {
      if (src[pos] !== '\\') return null;
      const cmd = readCmd();
      if (cmd === null) return null;

      // --- r6: \dfrac{d}{dx} [...] Leibniz 求导符号 ---
      //   检测: 第一参数是 d, 第二参数是 d<var> 形式
      //   var 可能是单字符 (x, y, t) 或希腊字母 (\theta, \mu) 已被 parseLatex 转成 theta, mu
      //   后面跟 \left[ \right] 或裸 f
      if (cmd === 'frac' || cmd === 'dfrac' || cmd === 'tfrac') {
        // ★ 先 peek 两个参数的原始 (未 parseLatex) 文本
        const savePos0 = pos;
        skipWs();
        // 读第一个 {…} 块 (raw)
        const aStart = pos;
        if (src[aStart] !== '{') {
          // 不是 Leibniz, 走普通 frac
        } else {
          let aDepth = 1, ai = aStart + 1;
          while (ai < src.length && aDepth > 0) {
            if (src[ai] === '{') aDepth++;
            else if (src[ai] === '}') aDepth--;
            ai++;
          }
          if (aDepth !== 0) {
            // 不平衡, 走普通
          } else {
            const aRaw = src.slice(aStart + 1, ai - 1).trim();
            pos = ai;
            skipWs();
            // 读第二个 {…} 块 (raw)
            if (src[pos] === '{') {
              const bStart = pos;
              let bDepth = 1, bi = bStart + 1;
              while (bi < src.length && bDepth > 0) {
                if (src[bi] === '{') bDepth++;
                else if (src[bi] === '}') bDepth--;
                bi++;
              }
              if (bDepth === 0) {
                const bRaw = src.slice(bStart + 1, bi - 1).trim();
                pos = bi;
                // 检测 Leibniz 模式: aRaw 是 d 或 d^<n> (n 阶), bRaw 是 d<var> 或 d<var>^<n> 形式
                //   var 可能是单字符 (x, y, t) 或希腊字母 \theta, \mu 等 (LaTeX 形式)
                // ★ r7: 支持高阶导数 d^n/dx^n (n=1, 2, 3, ...)
                let derivOrder = 1;  // 默认一阶
                let derivVar = null;
                // 先试一阶:  aRaw === 'd',  bRaw === d<var>  或  d\<greek>
                let aMatch = /^d$/i.exec(aRaw);
                let bMatch = /^d\s*([A-Za-z_][A-Za-z0-9_]*)$/i.exec(bRaw);
                if (!bMatch) {
                  const gMatch = /^d\s*\\([A-Za-z]+)$/i.exec(bRaw);
                  if (gMatch) bMatch = [bRaw, gMatch[1].toLowerCase()];
                }
                // 再试高阶:  aRaw === d^<n> 或 d^{<n>},  bRaw === d<var>^<n> 或 d<var>^{<n>}
                if (!aMatch || !bMatch) {
                  // aRaw:  d^<n>  或  d^{<n>}
                  const aHigh = /^d\s*\^\s*\{?(\d+)\}?$/i.exec(aRaw);
                  // bRaw:  d<var>^<n>  或  d<var>^{<n>}  或  d\<greek>^<n>
                  const bHigh1 = /^d\s*([A-Za-z_][A-Za-z0-9_]*)\s*\^\s*\{?(\d+)\}?$/i.exec(bRaw);
                  const bHigh2 = /^d\s*\\([A-Za-z]+)\s*\^\s*\{?(\d+)\}?$/i.exec(bRaw);
                  if (aHigh && (bHigh1 || bHigh2)) {
                    const orderA = parseInt(aHigh[1], 10);
                    const m = bHigh1 || bHigh2;
                    const orderB = parseInt(m[2], 10);
                    if (orderA === orderB && orderA >= 1 && orderA <= 20) {
                      aMatch = aHigh;
                      bMatch = [bRaw, m[1].toLowerCase()];
                      derivOrder = orderA;
                    }
                  }
                }
                if (aMatch && bMatch) {
                  const derivVar = bMatch[1];  // e.g. "x", "theta"
                  // 找 body: 跳过空白 + 可能的 \left[ ... \right] 或 裸表达式
                  skipWs();
                  let bodyStr = null;
                  if (src[pos] === '\\' && (src.slice(pos + 1, pos + 5) === 'left' || src.slice(pos + 1, pos + 5) === 'LEFT')) {
                    // \left[ ... \right] 或 \left( ... \right) 或 \left| ... \right|
                    pos += 5;  // 跳过 \left
                    // 找到 \left 后的左分隔符
                    while (pos < src.length && /\s/.test(src[pos])) pos++;
                    while (pos < src.length && src[pos] !== '[' && src[pos] !== '(' && src[pos] !== '|' && src[pos] !== '{') pos++;
                    if (pos < src.length) {
                      const openChar = src[pos]; pos++;
                      const closeChar = (openChar === '[') ? ']' : (openChar === '(') ? ')' : (openChar === '|') ? '|' : '}';
                      let cDepth = 1, ci = pos;
                      // 这里用配对字符平衡读
                      if (closeChar === '}') {
                        let d2 = 1; ci = pos;
                        while (ci < src.length && d2 > 0) {
                          if (src[ci] === '{') d2++;
                          else if (src[ci] === '}') d2--;
                          ci++;
                        }
                        bodyStr = src.slice(pos, ci - 1);
                        pos = ci;
                      } else {
                        // [] () | 都用字符平衡
                        const opens = openChar;
                        const closes = closeChar;
                        let d2 = 1; ci = pos;
                        while (ci < src.length && d2 > 0) {
                          if (src[ci] === opens) d2++;
                          else if (src[ci] === closes) d2--;
                          ci++;
                        }
                        bodyStr = src.slice(pos, ci - 1);
                        pos = ci;
                      }
                      // 跳过 \right
                      skipWs();
                      if (src.slice(pos + 1, pos + 6) === 'right' || src.slice(pos + 1, pos + 6) === 'RIGHT') {
                        pos += 6;
                        // 跳过 \right 后的右分隔符
                        while (pos < src.length && src[pos] !== ']' && src[pos] !== ')' && src[pos] !== '|' && src[pos] !== '}') pos++;
                        if (pos < src.length) pos++;
                      }
                    }
                  } else {
                    // 裸表达式: 读一个 balanced 块
                    bodyStr = readBalancedExpr();
                  }
                  if (bodyStr !== null) {
                    const parsedBody = parseLatex(bodyStr);
                    // ★ r7: 根据 derivOrder 嵌套 diff n 次 (n=1 时仍单层, n=2 时是 diff(diff(f,x),x))
                    let result = parsedBody;
                    for (let i = 0; i < derivOrder; i++) {
                      result = 'diff(' + result + ',' + derivVar + ')';
                    }
                    return { text: pushPlaceholder(result) };
                  }
                }
              }
            }
            // 不是 Leibniz 模式, 退回普通 frac 处理
            pos = savePos0;
          }
        }
      }

      // --- \frac / \dfrac / \tfrac ---
      if (cmd === 'frac' || cmd === 'dfrac' || cmd === 'tfrac') {
        const a = readArg(); if (a === null) return null;
        const b = readArg(); if (b === null) return null;
        const inner = '((' + a + '))/(' + b + ')';
        return { text: pushPlaceholder(inner) };
      }

      // --- \sqrt[n]{x} 或 \sqrt{x} ---
      if (cmd === 'sqrt') {
        let n = null;
        skipWs();
        if (src[pos] === '[') {
          const start = pos;
          let depth = 1, j = pos + 1;
          while (j < src.length && depth > 0) {
            if (src[j] === '[') depth++;
            else if (src[j] === ']') depth--;
            j++;
          }
          n = src.slice(start + 1, j - 1);
          pos = j;
        }
        const x = readBraced(); if (x === null) return null;
        let body;
        if (n != null) {
          body = '((' + parseLatex(x) + '))^(1/(' + parseLatex(n) + '))';
        } else {
          body = 'sqrt(' + parseLatex(x) + ')';
        }
        return { text: pushPlaceholder(body) };
      }

      // --- \sum / \prod ---
      //   body 读取 src 剩余的全部内容 (含嵌套的 \frac, \sum 等)
      //   但在顶层 + 或 - 处停下, 避免 body 吞掉后面的 \prod \int 等
      //   例: \sum_{k=1}^{3} k + \prod_{k=1}^{2} (t+k)  ->  sum(k,1,3,k) + product(k,1,2,(t+k))
      if (cmd === 'sum' || cmd === 'prod' || cmd === 'product') {
        const fn = (cmd === 'sum') ? 'sum' : 'product';
        let lo = null, hi = null;
        skipWs();
        if (src[pos] === '_') { pos++; lo = readScriptArg(); }
        skipWs();
        if (src[pos] === '^') { pos++; hi = readScriptArg(); }
        // 读 body = src 剩余内容直到顶层 + 或 -, 或末尾的 for 求导
        const r = readSumBodyToEnd();
        if (r == null || r.body == null) return null;
        const e = r.body;
        let varName = 'i', startVal = '1';
        if (lo) {
          // 解析 "var=start" -> var, start (lo 内可能含 \pi 之类的命令, 需先 parseLatex)
          const loTex = parseLatex(lo);
          const mm = loTex.match(/^([A-Za-z_]\w*)\s*=\s*(.+)$/);
          if (mm) { varName = mm[1]; startVal = mm[2]; }
          else { varName = loTex.trim(); }
        }
        const endVal = (hi ? parseLatex(hi) : '1');
        const body = fn + '(' + varName + ',' + startVal + ',' + endVal + ',' + e + ')';
        return { text: pushPlaceholder(body) + (r.suffix || '') };
      }

      // --- \int ---
      //   \int_a^b f dx      ->  integrate(f, x, a, b)  定积分
      //   \int f dx  /  \int_a f dx  /  \int^b f dx   ->  symbolicIntegrate(f, x)  不定积分
      //   body 读取 src 剩余的全部内容 (含嵌套的 \frac, \sum 等)
      if (cmd === 'int') {
        let lo = null, hi = null;
        skipWs();
        if (src[pos] === '_') { pos++; lo = readScriptArg(); }
        skipWs();
        if (src[pos] === '^') { pos++; hi = readScriptArg(); }
        // 跳过可选的 \, ; : ! 空白命令 (LaTeX 中 \int 后面常跟 \, dx)
        skipWs();
        if (src[pos] === '\\' && /[,;:\!]/.test(src[pos + 1] || '')) pos += 2;
        skipWs();
        // 在 src 当前位置向后找 dx 模式 (body + 空白/命令 + d<letter> + 终止/分隔)
        //   例: "e^t \sin t \, dt for f'(x)"  ->  body="e^t \sin t", varName="t", 跳过 dx 之后
        //   例: "e^x dx"                       ->  body="e^x", varName="x"
        const rest = src.slice(pos);
        // ★ 嵌套积分时, 外层的微分在末尾 (e.g. \int_0^x \int_0^t s^2 ds dt 末尾 dt 是外层)
        //   用 matchAll 找所有 d<letter>, 取最后一个
        const dxMatches = [...rest.matchAll(/(?:[\s\\,;:\!]+|^)d([A-Za-z])(?=[\s\\,;:\!]|$)/g)];
        let varName = 'x';
        let e;
        if (dxMatches.length > 0) {
          const lastM = dxMatches[dxMatches.length - 1];
          varName = lastM[1];
          // body = d<letter> 之前的内容, 去掉最后的 separator
          let bodyStr = rest.slice(0, lastM.index);
          // 去掉末尾的 separator ([\s\\,;:\!]+)
          bodyStr = bodyStr.replace(/[\s\\,;:\!]+$/, '');
          e = parseLatex(bodyStr);
          pos = pos + lastM.index + lastM[0].length;   // 跳过整个 dx 之后的所有内容
        } else {
          // ★ readBodyToEnd() 返回 { body, suffix }, 取 .body
          const r = readBodyToEnd();
          e = r ? r.body : '';
        }
        if (e == null) return null;
        // 缺任一上下界 -> 不定积分 (用 symbolicIntegrate 输出函数表达式)
        if (lo == null || hi == null) {
          const body = 'symbolicIntegrate(' + e + ',' + varName + ')';
          return { text: pushPlaceholder(body) };
        }
        const loTex = parseLatex(lo);
        const hiTex = parseLatex(hi);
        const body = 'integrate(' + e + ',' + varName + ',' + loTex + ',' + hiTex + ')';
        return { text: pushPlaceholder(body) };
      }

      // --- \lim ---
      //   body 读取 src 剩余的全部内容 (含嵌套的 \frac, \sum 等)
      if (cmd === 'lim') {
        let lo = null, limVar = 'x', limPoint = '0', limDir = 0;
        skipWs();
        if (src[pos] === '_') { pos++; lo = readScriptArg(); }
        if (lo) {
          // 解析 "x \to a" / "x -> a" / "x, a" / "x = a" -> limVar=x, limPoint=a
          // (lo 内可能含 \pi 等命令, 需先 parseLatex; \to 已经被替换成 ,)
          const loTex = parseLatex(lo);
          const mm = loTex.match(/^([A-Za-z_]\w*)\s*(?:->|=|,)\s*(.+)$/);
          if (mm) { limVar = mm[1]; limPoint = mm[2]; }
          else { limVar = loTex.trim(); }
          // ★ r11: 检测 limPoint 是否以 ^(+) 或 ^(-) 结尾 (LaTeX 0^+ / 0^+{} / 0^{-} 解析后都变 ^(+) / ^(-))
          //   单侧极限标记. 非贪婪 (.+?) 匹配最短 base.
          //   例: "0^(+)" -> base=0, dir=+1; "(-1)^(+)" -> base=(-1), dir=+1; "inf" -> 不匹配
          const dirMatch = limPoint.match(/^(.+?)\^\(([+-])\)\s*$/);
          if (dirMatch) {
            limPoint = dirMatch[1];
            limDir = (dirMatch[2] === '+') ? 1 : -1;
          }
        }
        // 读 body = src 剩余全部内容
        const r = readBodyToEnd();
        if (r == null || r.body == null) return null;
        const e = r.body;
        // ★ r11: 有方向时发 4-arg `limit(e, limVar, limPoint, +1)`, 否则 3-arg (兼容)
        const body = limDir !== 0
          ? 'limit(' + e + ',' + limVar + ',' + limPoint + ',' + (limDir > 0 ? '+1' : '-1') + ')'
          : 'limit(' + e + ',' + limVar + ',' + limPoint + ')';
        return { text: pushPlaceholder(body) + r.suffix };
      }

      // --- 希腊字母 ---
      const greek = {
        'alpha':'alpha','beta':'beta','gamma':'gamma','delta':'delta',
        'epsilon':'eps','varepsilon':'eps','zeta':'zeta','eta':'eta',
        'theta':'theta','vartheta':'theta','iota':'iota','kappa':'kappa',
        'lambda':'lambda','mu':'mu','nu':'nu','xi':'xi','rho':'rho',
        'sigma':'sigma','varsigma':'sigma','tau':'tau','upsilon':'upsilon',
        'phi':'phi','varphi':'phi','chi':'chi','psi':'psi','omega':'omega',
        'Gamma':'Gamma','Delta':'Delta','Theta':'Theta','Lambda':'Lambda',
        'Xi':'Xi','Pi':'Pi','Sigma':'Sigma','Upsilon':'Upsilon',
        'Phi':'Phi','Psi':'Psi','Omega':'Omega',
        'infty':'inf','partial':'d','nabla':'nabla','pi':'pi',
      };
      if (greek[cmd]) {
        return { text: pushPlaceholder(greek[cmd]) };
      }

      // --- 运算符 ---
      const ops = {
        'cdot':'*','times':'*','ast':'*','star':'*','div':'/',
        'pm':'+','mp':'-',
        'leq':'<=','le':'<=',
        'geq':'>=','ge':'>=',
        'neq':'!=','ne':'!=',
        'approx':'~=','sim':'~=','equiv':'==',
        'to':',','rightarrow':',','leftarrow':',',
        'mapsto':',',
      };
      if (ops[cmd] !== undefined) {
        return { text: pushPlaceholder(ops[cmd]) };
      }

      // --- r5: 二项式系数 (两参数 \binom{n}{k} / \tbinom / \dbinom) ---
      if (cmd === 'binom' || cmd === 'tbinom' || cmd === 'dbinom') {
        // 解析两个 {a}{b} 参数, 输出 binom(a,b) (统一为 binom, tbinom/dbinom 是显示样式变体)
        // 跳过空白
        let p = pos;
        while (p < src.length && /\s/.test(src[p])) p++;
        if (src[p] === '{') {
          const savePos = pos;
          pos = p;
          const arg1 = readBraced();
          if (arg1 !== null) {
            const afterFirst = pos;
            // 跳过空白 + 可选 { 包裹
            let q = afterFirst;
            while (q < src.length && /\s/.test(src[q])) q++;
            if (src[q] === '{') {
              pos = q;
              const arg2 = readBraced();
              if (arg2 !== null) {
                const a1 = parseLatex(arg1);
                const a2 = parseLatex(arg2);
                const advanceTo = pos;  // pos 现在在第二个 } 之后
                pos = savePos;
                pos = advanceTo;
                return { text: pushPlaceholder('binom(' + a1 + ',' + a2 + ')') };
              }
            }
          }
          pos = savePos;
        }
        // fallback: 把 cmd 删掉, 让后续把每个字母当 identifier (不会死循环)
        return { text: pushPlaceholder(cmd) };
      }

      // --- 三角/对数/双曲 (去掉反斜杠) ---
      const funcs = ['arcsin','arccos','arctan','sinh','cosh','tanh',
                     'sin','cos','tan','csc','sec','cot',
                     'log','ln','exp','deg','det','arg','mod'];
      if (funcs.indexOf(cmd) >= 0) {
        // 消耗可选的空白/间隔符 (\, \; ...) + 空格 + 函数参数
        //   \sin x        -> sin(x)
        //   \sin{x}       -> sin(x)
        //   \sin\, x      -> sin(x)   (跳过 \,)
        //   \sin x^2      -> sin(x^(2))
        //   \sin          -> sin (没参数, 比如用于 sin*cos)
        let p = pos;
        // 跳过空白和空白命令
        while (p < src.length) {
          if (/\s/.test(src[p])) { p++; continue; }
          if (src[p] === '\\') {
            const next = src.slice(p + 1).match(/^([A-Za-z]+|.)/);
            if (next && (next[1] === ',' || next[1] === ';' || next[1] === ':' || next[1] === '!' || next[1] === ' ')) {
              p += 1 + next[1].length;
              continue;
            }
          }
          break;
        }
        // ★ r9: \sin^n x 形式 - ^<n> 作用在 sin(args) 整体 (math 惯例)
        //   \sin^4 x        -> sin(x)^(4)
        //   \sin^{2n} x     -> sin(x)^(2n)
        //   \sin^4 (x+1)    -> sin(x+1)^(4)
        //   \sin^2 3x       -> sin(3x)^(2)
        if (src[p] === '^') {
          const savePosSup = pos; pos = p + 1;   // skip ^ 自身
          const sup = readScriptArg();
          if (sup !== null) {
            const afterSup = pos;
            pos = savePosSup;
            const argRes = _readFuncArg(afterSup);
            if (argRes !== null) {
              pos = savePosSup; pos = argRes.advanceTo;
              return { text: pushPlaceholder(cmd + '(' + argRes.arg + ')^(' + parseLatex(sup) + ')') };
            }
          }
          pos = savePosSup;
        }
        let arg = null, advanceTo = p;
        if (src[p] === '{') {
          // {x} 参数
          const savePos = pos; pos = p;
          const inner = readBraced();
          advanceTo = pos;
          if (inner !== null) arg = parseLatex(inner);
          pos = savePos;
        } else if (src[p] === '(') {
          // (...) 参数: 读平衡块, 用内容递归
          let depth = 1, j = p + 1;
          while (j < src.length && depth > 0) {
            if (src[j] === '(') depth++;
            else if (src[j] === ')') depth--;
            j++;
          }
          if (depth === 0) {
            const inner = src.slice(p + 1, j - 1);
            arg = parseLatex(inner);
            advanceTo = j;
          }
        } else if (/[A-Za-z0-9\\]/.test(src[p] || '')) {
          // ★ r15-amend4: 数字/字母/\\ 开头的 arg, 用 _readBareAtom 扫整个 bare atom
          //   \cos 2x   -> cos(2*x)   (数字+字母)
          //   \cos 2x^2 -> cos(2*x^(2)) (数字+字母+脚本)
          //   \cos x    -> cos(x)     (单字母, 回归)
          //   \cos ax   -> cos(a*x)   (字母+字母, 隐式乘)
          //   \cos 2    -> cos(2)     (纯数字)
          //   \cos \pi  -> cos(pi)    (\command 也算 atom)
          const atom = _readBareAtom(p);
          if (atom !== null && atom.str.length > 0) {
            arg = parseLatex(atom.str);
            advanceTo = atom.end;
          }
        }
        if (arg !== null) {
          pos = advanceTo;
          return { text: pushPlaceholder(cmd + '(' + arg + ')') };
        }
        return { text: pushPlaceholder(cmd) };
      }

      // --- 空白/间隔符 (\, \; \: \! ~ \\ + 空格): 删除 ---
      //   也包括 \big, \Big, \bigg, \Bigg (LaTeX 括号尺寸, 不需保留)
      //   ★ r15-amend7: \left / \right 是配对括号尺寸, 输出匹配的开/闭括号字符
      //     \left[ ... \right] -> ( ... )  (方括号是视觉装饰, 转圆括号)
      //     \left( ... \right) -> ( ... )
      //     \left| ... \right| -> | ... |
      //     \left\{ ... \right\} -> { ... }
      //     \left. / \right. 单点变体 -> 不输出 (开区间记号, 删命令保留 .)
      if (cmd === ',' || cmd === ';' || cmd === ':' || cmd === '!' || cmd === ' ' || cmd === 'quad' || cmd === 'qquad') {
        return { text: '' };
      }
      if (cmd === 'big' || cmd === 'Big' || cmd === 'bigg' || cmd === 'Bigg') {
        // \big 系列不强制配对, 不删括号
        return { text: '' };
      }
      if (cmd === 'left') {
        skipWs();
        if (pos >= src.length) return { text: '' };
        const b = src[pos];
        if (b === '.') {
          // \left. 单点变体: 删命令, 保留 . (用于开区间)
          return { text: '' };
        }
        pos++;   // 消耗 1 个括号字符
        // \left[ 转 (,  \left( 转 (,  \left| 转 |,  \left\{ 转 {
        if (b === '[' || b === '(') return { text: '(' };
        if (b === '|') return { text: '|' };
        if (b === '{') return { text: '{' };
        return { text: '' };
      }
      if (cmd === 'right') {
        skipWs();
        if (pos >= src.length) return { text: '' };
        const b = src[pos];
        if (b === '.') {
          // \right. 单点变体: 删命令, 保留 .
          return { text: '' };
        }
        pos++;
        // \right] 转 ),  \right) 转 ),  \right| 转 |,  \right\} 转 }
        if (b === ']' || b === ')') return { text: ')' };
        if (b === '|') return { text: '|' };
        if (b === '}') return { text: '}' };
        return { text: '' };
      }

      // 未知命令: 直接删掉反斜杠, 保留名字
      return { text: pushPlaceholder(cmd) };
    }

    // 主循环: 扫描整个 src, 输出转换后的字符串
    let out = '';
    pos = 0;
    while (pos < src.length) {
      const c = src[pos];
      if (c === '\\') {
        const r = processCommand();
        if (r) out += r.text;
        else { out += c; pos++; }
      } else if (c === '{') {
        const inner = readBraced();
        if (inner !== null) {
          // 递归转换 {…} 内部
          out += parseLatex(inner);
        } else {
          out += c; pos++;
        }
      } else if (c === '}') {
        // 孤立 }, 跳过
        pos++;
      } else if (c === '^' || c === '_') {
        // 单独的 ^ 或 _ (不在 \command 后, 也不在 {…} 内的下标)
        //   ^2 -> ^(2), x_1 -> x (下标不支持, 删掉)
        pos++;  // ★ 先跳过 ^ 或 _ 本身
        skipWs();
        if (c === '^') {
          const a = readScriptArg();
          if (a !== null) {
            out += '^(' + parseLatex(a) + ')';
          }
        } else {
          readScriptArg();   // 下标直接丢弃
        }
      } else {
        // 收集连续的 [A-Za-z_]+ run, 检查是否是 "裸函数名 + ( 或 {"
        if (/[A-Za-z_]/.test(c)) {
          const start = pos;
          while (pos < src.length && /[A-Za-z0-9_]/.test(src[pos])) pos++;
          const word = src.slice(start, pos);
          // ★ r9: 裸函数名 + ^<n> 形式 (与 funcs 分支一致, ^<n> 作用在 word(args) 整体)
          //   sin^4 x        -> sin(x)^(4)
          //   sin^{2n} x     -> sin(x)^(2n)
          //   sin^4 (x+1)    -> sin(x+1)^(4)
          if (_LATEX_BARE_FUNCS.has(word)) {
            let q = pos;
            while (q < src.length && /\s/.test(src[q])) q++;
            if (src[q] === '^') {
              const savePosSup = pos; pos = q + 1;
              const sup = readScriptArg();
              if (sup !== null) {
                const afterSup = pos;
                pos = savePosSup;
                const argRes = _readFuncArg(afterSup);
                if (argRes !== null) {
                  pos = savePosSup; pos = argRes.advanceTo;
                  out += pushPlaceholder(word + '(' + argRes.arg + ')^(' + parseLatex(sup) + ')');
                  continue;
                }
              }
              pos = savePosSup;
            }
          }
          // 跳过空白, 看后面是 ( 还是 {
          let q = pos;
          while (q < src.length && /\s/.test(src[q])) q++;
          const next = src[q];
          if ((next === '(' || next === '{') && _LATEX_BARE_FUNCS.has(word)) {
            // 裸函数调用: 消耗 ( 或 { 包裹的参数
            if (next === '(') {
              // 读平衡 (...)
              let depth = 1, j = q + 1;
              while (j < src.length && depth > 0) {
                if (src[j] === '(') depth++;
                else if (src[j] === ')') depth--;
                j++;
              }
              if (depth === 0) {
                const inner = src.slice(q + 1, j - 1);
                out += pushPlaceholder(word + '(' + parseLatex(inner) + ')');
                pos = j;
                continue;
              }
              // 不平衡: 当普通文字
              out += word;
              continue;
            } else {
              // next === '{'
              // 借用 processCommand 里的 readBraced
              const savePos = pos; pos = q;
              const inner = readBraced();
              if (inner !== null) {
                out += pushPlaceholder(word + '(' + parseLatex(inner) + ')');
                continue;
              }
              pos = savePos;
              out += word;
              continue;
            }
          }
          // 不是裸函数: 把 word 整个加到 out (留给 known-id 步骤处理)
          // ★ Bug 11 修复: word 后面紧跟 \left( 时, word 不是已知函数, 插入 *
          //   避免 x\left(...\right) 被转为 x(...) 误读为函数调用
          if (next === '\\' && q < src.length) {
            const cmdMatch = src.slice(q + 1).match(/^[A-Za-z]+/);
            if (cmdMatch && cmdMatch[0].toLowerCase() === 'left') {
              out += word + '*';
            } else {
              out += word;
            }
          } else {
            out += word;
          }
        } else {
          out += c; pos++;
        }
      }
    }

    // ---------- 2) 处理 \left, \right, \big, \Big, \bigg, \Bigg ----------
    //   (在 processCommand 中已处理为删除, 此处保留是为了双重保险 - 万一有遗漏)
    out = out.replace(/\\(left|right|big|Big|bigg|Bigg)\b/g, '');

    // ---------- 3) 把占位符回填 (递归: 占位符内可能含更内层占位符) ----------
    function substitutePlaceholders(s) {
      let prev;
      do {
        prev = s;
        s = s.replace(/\x01(\d+)\x02/g, (m, id) => {
          const p = placeholders[+id];
          return p != null ? p : m;
        });
      } while (s !== prev);
      return s;
    }
    out = substitutePlaceholders(out);

    // ---------- 4) 隐式乘 * 插入 ----------
    // 数字-( 或 数字-字母
    out = out.replace(/(\d(?:\.\d+)?)([A-Za-z_(])/g, '$1*$2');

    // 空白在两个 letter/digit/parens 之间时, 视为隐式乘 (*)
    //   pi r -> pi*r ;  2 x -> 2*x ;  (a)(b) -> (a)*(b) (如果适用)
    out = out.replace(/([A-Za-z0-9_\)])\s+([A-Za-z0-9_\(])/g, '$1*$2');

    // 已知标识符词典 (letter-letter 跨边界分割, 也包括 ^/_ 跨边界)
    // 例: pir^2 -> pi*r^2 ;  sinx -> sin*x ;  betapi -> beta*pi
    const knownIds = [
      'arcsin','arccos','arctan','asinh','acosh','atanh','sinh','cosh','tanh',
      'sin','cos','tan','csc','sec','cot','asin','acos','atan',
      'log','ln','exp','sqrt','cbrt','abs','round','floor','ceil',
      'min','max','sum','product','diff','integrate','limit',
      'solve','det','arg','mod','sign',
      'symbolicDiff','symbolicIntegrate',
      // ★ r5: 二项式系数 (避免被切成 b*i*n*o*m)
      'binom','tbinom','dbinom',
      'alpha','beta','gamma','delta','epsilon','zeta','eta','theta',
      'kappa','lambda','mu','nu','xi','rho','sigma','tau','phi',
      'chi','psi','omega','infty','nabla','pi',
      'inf','nan'  // ★ inf/nan 是 from \infty/\nan 的实际值, 也要保护避免被切
    ];
    const knownIdSet = new Set(knownIds);
    // 长度倒序, 长名字优先 (arcsin 优先于 sin)
    knownIds.sort((a, b) => b.length - a.length);

    // 按 letter run (连续的 [A-Za-z_]+) 单独处理, 避免贪婪问题
    out = out.replace(/[A-Za-z_]+/g, (word) => {
      if (knownIdSet.has(word)) return word;   // 整个词是已知 id, 不切
      // 试前缀 / 后缀匹配
      for (const id of knownIds) {
        if (id.length >= word.length) continue;
        if (word.startsWith(id) && word.length - id.length === 1) {
          // 已知 id 在前, 后面单字符变量
          return id + '*' + word.slice(id.length);
        }
        if (word.endsWith(id) && word.length - id.length === 1) {
          // 已知 id 在后, 前面单字符变量
          return word.slice(0, word.length - id.length) + '*' + id;
        }
      }
      // ★ 新增: 没有已知 id 边界, 但 word 长度 >= 2 且全是单字符变量 (kjx, abc, xy)
      //   拆为单字符 * 单字符 (kjx -> k*j*x, xy -> x*y)
      //   避免 evaluate 时把 "kjx" 当作单变量
      if (word.length >= 2) return word.split('').join('*');
      return word;
    });

    // letter-paren: 完整标识符后跟 ( 才判断
    //   - 已知函数 (sin, cos, ln, sqrt 等):  直接函数调用
    //   - 单字母 (f, g, h, x, y 等):  在数学里 f(x) g(y) h(t) 几乎都是函数调用,
    //     保留 f( 不插 *, 否则 f(x)=... 这种函数定义会被改成 f*(x)=...
    //   - 多字母非已知 (fvar, myFn):  视为 implicit mul, 插入 *
    out = out.replace(/([A-Za-z_][A-Za-z0-9_]*)\(/g, (m, id) => {
      if (knownIdSet.has(id) || id.length === 1) return id + '(';
      return id + '*(';
    });

    // ---------- 5) 清理剩余花括号 ----------
    out = out.replace(/[{}]/g, '');

    // ---------- 6) 清理多余空格 (已处理过 letter-letter, 剩下的都是无效空白) ----------
    out = out.replace(/\s+/g, '');

    return out;
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

  // limit(expr, varName, point[, direction], options)
  // expr:    字符串
  // varName: 字符串
  // point:   字符串/数字  ->  内部用 String(point) 转发给 Python,  支持 "inf"/"-inf"/"nan"
  // direction: 可选, -1/0/+1.  转发给 Python /limit 端点 (mpmath 内部走单/双侧).
  //   JS 路径 (autoStartPython=false) 拼字符串 'limit(expr, var, point, direction)' 给 _evalLimit.
  //   不传时维持原 3-arg 行为 (向后兼容, 不发到 Python request body)
  function limitAsync(expr, varName, point, options, direction) {
    if (typeof expr !== 'string') throw new TypeError('expr must be a string');
    if (typeof varName !== 'string' || !varName) throw new TypeError('varName must be a non-empty string');
    options = options || {};
    const timeout = options.timeout || config.timeout;
    const usePython = !!(options.pythonUrl || config.pythonUrl || options.autoStartPython || config.pythonAutoStart);

    // r12: direction 校验 (-1, 0, +1).  null/undefined 表示未传, 跳过校验
    if (direction != null) {
      const d = Number(direction);
      if (!Number.isInteger(d) || d < -1 || d > 1) {
        throw new Error('limitAsync: direction 必须是 -1, 0, +1, 实际: ' + direction);
      }
      direction = d;  // 规整化为整数
    }

    if (usePython) {
      // Python 后端: 走 mpmath.limit, 任意精度
      // ★ Bug 11 修复: 把 Infinity/-Infinity/'Infinity' 等归一化为 inf/-inf
      //   Python mpmath 只识 inf/-inf, 不识 JS 的 'Infinity' (String(Infinity)='Infinity')
      //   之前未归一化导致 Python 端收到 'Infinity' 返回 NaN/报错
      const body = {
        expression: expr,
        variable: varName,
        point: _normalizeInfBound(point),
        precision: options.precision || config.defaultPrecision,
        pythonUrl: options.pythonUrl,
        autoStartPython: !!(options.autoStartPython || config.pythonAutoStart),
        pythonPort: options.pythonPort || config.pythonPort,
        pythonHost: options.pythonHost || config.pythonHost,
        pythonScript: options.pythonScript,
        pythonCmd: options.pythonCmd,
        installMpmath: options.installMpmath,
        timeout: timeout
      };
      if (direction != null) body.direction = direction;  // r12: 转发 direction
      return withTimeout(
        callPython('/limit', body, timeout),
        timeout,
        'limitAsync'
      );
    }

    // 纯 JS 路径: 走 evaluate('limit(expr, var, point[, direction])'), 让 _evalLimit 处理
    // ★ Bug 11: JS 路径也归一化 Infinity -> inf, 保持与 Python 路径一致
    const ptNorm = _normalizeInfBound(point);
    let limitStr;
    if (direction != null) {
      // 4-arg: 拼 'limit(expr, var, point, +1/-1/0)'
      const dirStr = direction > 0 ? '+1' : (direction < 0 ? '-1' : '0');
      limitStr = 'limit(' + expr + ',' + varName + ',' + ptNorm + ',' + dirStr + ')';
    } else {
      limitStr = 'limit(' + expr + ',' + varName + ',' + ptNorm + ')';
    }
    return withTimeout(new Promise(function (resolve, reject) {
      try {
        resolve(evaluate(limitStr));
      } catch (e) { reject(e); }
    }), timeout, 'limitAsync');
  }

  // ★ r15-amend3: 把 JS 阶乘语法 n! 翻译为 Python factorial(n).
  //   Python mpmath 不识 `!` 后缀算子 (不是合法 Python 语法, ast.parse 会 SyntaxError -> HTTP 400).
  //   Python 端已有 _doublebang_to_doublefact 处理 n!! (双阶乘), 但漏了 n! (单阶乘).
  //   修复在 JS→Python 边界: 扫 body 找单 ! (确保不是 !!), 向前回溯到原子 (NAME/NUMBER/平衡括号),
  //   替换为 factorial(ATOM).
  //   例:  n! -> factorial(n);  (n+1)! -> factorial((n+1));  n!! 不动 (留给 Python 端)
  //   ★ r15-amend9 Bug 6.1: 旧实现一次性收集所有 ! 位置, 但外层 ! 的原子范围可能含内层 ! 位置;
  //     外层替换后 result 长度变化, 内层 ! 的原始位置失效, 产出非法 Python (如 (n!)! -> factorial(fa)torial((n!)) ).
  //     改为: 每次替换后重新扫描 result 找第一个单 !, 用 scanFrom 游标跳过无法回溯原子的 ! (如 !! 的尾部).
  function _toPythonBody(body) {
    if (typeof body !== 'string' || body.length === 0) return body;
    let result = body;
    let scanFrom = 0;
    let guard = 0;
    while (guard++ < 200) {
      // 找第一个单 ! (非 !!)
      let idx = -1;
      for (let i = scanFrom; i < result.length; i++) {
        if (result.charCodeAt(i) === 33 /* '!' */ && result.charCodeAt(i + 1) !== 33) {
          idx = i;
          break;
        }
      }
      if (idx < 0) break;  // 没有单 ! 了 (剩余 !! 留给 Python 端 _doublebang_to_doublefact)
      // 向前回溯找原子起点 (跳过空白)
      let j = idx - 1;
      while (j >= 0 && (result.charCodeAt(j) === 32 || result.charCodeAt(j) === 9)) j--;
      let atomStart = -1, atom = '';
      if (j >= 0) {
        const c = result.charCodeAt(j);
        if (c === 41 /* ')' */) {
          // 平衡括号: 找匹配的 (
          let depth = 1;
          let k = j - 1;
          while (k >= 0 && depth > 0) {
            const ck = result.charCodeAt(k);
            if (ck === 41) depth++;
            else if (ck === 40) depth--;
            k--;
          }
          atomStart = k + 1;
          atom = result.substring(atomStart, j + 1);
        } else if ((c >= 48 && c <= 57) /* 0-9 */ ||
                   (c >= 65 && c <= 90)  /* A-Z */ ||
                   (c >= 97 && c <= 122) /* a-z */ ||
                   c === 95 /* '_' */ || c === 46 /* '.' */) {
          // NAME 或 NUMBER: 回溯到非标识符字符
          let k = j;
          while (k >= 0) {
            const ck = result.charCodeAt(k);
            const isWord = (ck >= 48 && ck <= 57) || (ck >= 65 && ck <= 90) ||
                           (ck >= 97 && ck <= 122) || ck === 95 || ck === 46;
            if (!isWord) break;
            k--;
          }
          atomStart = k + 1;
          atom = result.substring(atomStart, j + 1);
        }
      }
      if (atomStart < 0 || !atom) {
        // ! 之前不是原子 (运算符等, 如 !! 的尾部 !) -> 跳过此 !, 游标前进避免死循环
        scanFrom = idx + 1;
        continue;
      }
      result = result.substring(0, atomStart) + 'factorial(' + atom + ')' + result.substring(idx + 1);
      scanFrom = 0;  // 替换后字符串变化, 从头重扫 (前面无单 !, 实际从 atomStart 之后即可, 0 安全)
    }
    return result;
  }

  // 数值无穷级数: nsumAsync(变量, 下界, 表达式, options)
  //   sum(k, lo, inf, body) -> nsumAsync('k', lo, 'body', {precision:50})
  //   走 Python mpmath.nsum, 50+ 位精度
  function nsumAsync(varName, start, expr, options) {
    if (typeof varName !== 'string' || !varName) throw new TypeError('varName must be a non-empty string');
    if (typeof expr !== 'string') throw new TypeError('expr must be a string');
    options = options || {};
    const timeout = options.timeout || config.timeout;
    const usePython = !!(options.pythonUrl || config.pythonUrl || options.autoStartPython || config.pythonAutoStart);

    if (usePython) {
      // ★ r15-amend3: n! 阶乘语法转 Python factorial(X)
      const pyExpr = _toPythonBody(expr);
      return withTimeout(
        callPython('/nsum', {
          expression: pyExpr,
          variable: varName,
          start: _coerceNsumStart(start, 0),
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
        'nsumAsync'
      );
    }

    return Promise.reject(new Error('nsum requires Python backend (pass pythonUrl or autoStartPython:true)'));
  }

  // r15: 数值无穷乘积 nprodAsync(变量, 下界, 表达式, options)
  //   product(n, 2, inf, body) -> nprodAsync('n', 2, 'body', {precision:50})
  //   走 Python mpmath.nprod
  function nprodAsync(varName, start, expr, options, vars) {
    if (typeof varName !== 'string' || !varName) throw new TypeError('varName must be a non-empty string');
    if (typeof expr !== 'string') throw new TypeError('expr must be a string');
    options = options || {};
    const timeout = options.timeout || config.timeout;
    const usePython = !!(options.pythonUrl || config.pythonUrl || options.autoStartPython || config.pythonAutoStart);

    // ★ Bug 54 修复: 接受第 5 个参数 vars, 把非常量变量代入 expr 后再发给 Python
    //   例: nprodAsync('n', 1, '1-x^2/n^2', opts, {x:0.5}) -> body 变为 1-0.5^2/n^2
    //   不替换 varName 本身 (乘积的 dummy 变量); vars 为空/省略时行为不变 (向后兼容)
    let finalExpr = expr;
    if (vars && typeof vars === 'object') {
      try {
        let ast = parse(expr);
        for (const k in vars) {
          if (Object.prototype.hasOwnProperty.call(vars, k) && k !== varName) {
            ast = _substituteVar(ast, k, _newNum(vars[k]));
          }
        }
        finalExpr = _astToString(ast);
      } catch (_) { /* 解析失败, 用原 expr */ }
    }

    if (usePython) {
      // ★ r15-amend3: n! 阶乘语法转 Python factorial(X)
      const pyExpr = _toPythonBody(finalExpr);
      return withTimeout(
        callPython('/nprod', {
          expression: pyExpr,
          variable: varName,
          start: _coerceNsumStart(start, 1),
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
        'nprodAsync'
      );
    }

    return Promise.reject(new Error('nprod requires Python backend (pass pythonUrl or autoStartPython:true)'));
  }

  // ★ r10-amend: 把 Infinity/-Infinity 归一化为 inf/-inf 字符串, 给 Python 用
  //   JS `String(Infinity) = 'Infinity'` (大写), Python `_MP_CONSTANTS` 只识 `inf`/`Inf`/`INF`, 不识 `Infinity` → HTTP 400
  //   接受多种输入形式 (number 或 string), 防御性
  function _normalizeInfBound(x) {
    if (x === Infinity || x === 'Infinity' || x === 'Inf' || x === 'INF') return 'inf';
    if (x === -Infinity || x === '-Infinity' || x === '-Inf' || x === '-INF') return '-inf';
    return String(x);
  }

  // ★ r15-amend9 Bug 5.1 + 4.1: nsum/nprod start 规整化
  //   - Bug 5.1: start=0 不被 `Number(start) || default` 改为 default (Number(0)||1 === 1)
  //   - Bug 4.1: fromRaw=±Infinity 路由到 marker 后, bot 把 'inf'/'-inf' 字符串传回 nsumAsync;
  //     此处必须透传字符串给 Python, 不能 Number() (Number('inf')=NaN, JSON.stringify(Infinity)=null)
  function _coerceNsumStart(start, defaultVal) {
    if (start == null) return defaultVal;
    if (start === Infinity) return 'inf';
    if (start === -Infinity) return '-inf';
    if (typeof start === 'string') {
      const s = start.trim();
      if (/^\+?inf$/i.test(s) || /^\+?infinity$/i.test(s)) return 'inf';
      if (/^-inf$/i.test(s) || /^-infinity$/i.test(s)) return '-inf';
    }
    return Number(start);
  }

  // ★ r10: 数值无穷界定积分 integrateAsync(表达式, 变量, 下界, 上界, options)
  //   integrate(f, x, 0, inf) -> integrateAsync('f', 'x', 0, 'inf', {precision:50})
  //   integrate(f, x, -inf, inf) -> integrateAsync('f', 'x', '-inf', 'inf', ...)
  //   走 Python /evaluate 端点, 内部 _py_integrate 用 mpmath.quad, 原生支持 inf/-inf
  //   50+ 位精度
  //   a, b 接受 number (e.g. 0, 1) 和 string (e.g. 'inf', '-inf', 'Infinity', '-Infinity')
  //   内部用 String(a) 序列化; Python 端会识别 inf 名字 (mpmath 约定)
  function integrateAsync(expr, varName, a, b, options) {
    if (typeof expr !== 'string') throw new TypeError('expr must be a string');
    if (typeof varName !== 'string' || !varName) throw new TypeError('varName must be a non-empty string');
    options = options || {};
    const timeout = options.timeout || config.timeout;
    const usePython = !!(options.pythonUrl || config.pythonUrl || options.autoStartPython || config.pythonAutoStart);

    if (usePython) {
      // 构造 integrate(expr, var, a, b) 表达式, 让 Python _eval 走 _py_integrate
      //   ★ r10-amend: a/b 用 _normalizeInfBound 归一化, 把 Infinity/-Infinity (number 或 string) -> inf/-inf
      //     Python _MP_CONSTANTS 不识 'Infinity' (大写), 否则 HTTP 400
      //   Python _py_integrate 用 mpmath.quad(f, [a, b]), a/b 是 mpf, inf/-inf 原生支持
      //   ★ r15-amend3: expr 含 n! 阶乘语法, 调 _toPythonBody 转 Python factorial(X)
      const aStr = _normalizeInfBound(a);
      const bStr = _normalizeInfBound(b);
      const pyExpr = _toPythonBody(expr);
      const fullExpr = 'integrate(' + pyExpr + ',' + varName + ',' + aStr + ',' + bStr + ')';
      return withTimeout(
        callPython('/evaluate', {
          expression: fullExpr,
          variables: {},
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
        'integrateAsync'
      );
    }

    return Promise.reject(new Error('integrateAsync requires Python backend (pass pythonUrl or autoStartPython:true)'));
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
    nsumAsync: nsumAsync,
    nprodAsync: nprodAsync,
    integrateAsync: integrateAsync,
    // 符号求导: 输入表达式和变量名, 返回导函数表达式字符串
    symbolicDiff: symbolicDiff,
    // 符号不定积分: 输入表达式和变量名, 返回反导函数表达式字符串 (含 +C)
    symbolicIntegrate: symbolicIntegrate,
    // 符号 product (自由变量上界): 输入 product(...) 表达式, 返回化简字符串
    symbolicProduct: symbolicProduct,
    // 符号 sum (自由变量上界): 输入 sum(...) 表达式, 返回化简字符串
    symbolicSum: symbolicSum,
    // LaTeX 输入解析
    parseLatex: parseLatex,
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
      _symbolicDiff: _symbolicDiff,
      _simplifyAst: _simplifyAst,
      _astToString: _astToString,
      _dependsOn: _dependsOn,
      _toPythonBody: _toPythonBody,
      _coerceNsumStart: _coerceNsumStart,
      _normalizeInfBound: _normalizeInfBound,
      config: config,
      FUNCTIONS: FUNCTIONS,
      CONSTANTS: CONSTANTS
    }
  };
}));
