export interface LanguageConfig {
  name: string;
  extensions: string[];
  /** Filenames (no extension) that should also map here, e.g. "Rakefile" */
  filenames?: string[];
  /** Keywords that signal a structural boundary and their weight */
  structuralKeywords: Record<string, number>;
  /** Lines that are pure comments get zero signal */
  commentPrefixes: string[];
  /** Line patterns that are docstrings or block comments */
  blockCommentStart: string;
  blockCommentEnd: string;
  /** Multipliers for indentation depth */
  indentWeight: number;
  /** Decorator/annotation weight */
  decoratorWeight: number;
  /** If true, block comment delimiters must appear at the start of the line */
  blockCommentAtLineStart?: boolean;
  /**
   * If true, block comment end tracking uses paren-depth counting
   * (for Clojure-style (comment ...) forms with nested S-expressions).
   */
  blockCommentUsesParenDepth?: boolean;
  /**
   * If true, block comments nest: every `blockCommentStart` inside a block
   * comment increments depth and every `blockCommentEnd` decrements it
   * (Scheme / Common Lisp `#| ... #| ... |# ... |#`).
   */
  blockCommentNests?: boolean;
  /**
   * Characters that open and close a string literal. Defaults to
   * `"`, `'` and backtick. Lisps set this to just `"` because `'` is the
   * quote reader macro and backtick is quasiquote / syntax-quote.
   */
  stringDelimiters?: string[];
  /**
   * If true, a backslash outside a string literal escapes the next
   * character — Clojure `\"` / `\(`, Scheme `#\"`, Emacs Lisp `?\"`.
   * Without this a `\"` char literal would open a phantom string that
   * masks the rest of the line.
   */
  backslashCharLiterals?: boolean;
  /**
   * Language family, used by label inference. `"lisp"` enables the
   * generic `(def* name ...)` / `(define* name ...)` labelling rule.
   */
  family?: "lisp";
}

// ─── Base keyword sets ───────────────────────────────────────

const cLikeKeywords: Record<string, number> = {
  class: 1.0,
  export: 0.6,
  import: 0.6,
  public: 0.3,
  private: 0.3,
  protected: 0.3,
  abstract: 0.4,
  static: 0.3,
  async: 0.3,
  const: 0.3,
  let: 0.2,
  var: 0.2,
  if: 0.3,
  else: 0.2,
  for: 0.3,
  while: 0.3,
  do: 0.2,
  switch: 0.3,
  case: 0.2,
  default: 0.2,
  try: 0.3,
  catch: 0.3,
  finally: 0.2,
  return: 0.2,
  throw: 0.2,
};

const jsLikeKeywords: Record<string, number> = {
  ...cLikeKeywords,
  function: 0.9,
};

const tsLikeKeywords: Record<string, number> = {
  ...jsLikeKeywords,
  interface: 0.9,
  type: 0.5,
  enum: 0.8,
};

// ─── Language configurations ─────────────────────────────────

const pythonConfig: LanguageConfig = {
  name: "python",
  extensions: [".py", ".pyi", ".pyx"],
  structuralKeywords: {
    class: 1.0,
    def: 0.9,
    import: 0.6,
    from: 0.5,
    return: 0.2,
    yield: 0.2,
    raise: 0.2,
    if: 0.3,
    elif: 0.2,
    else: 0.2,
    try: 0.3,
    except: 0.3,
    finally: 0.2,
    for: 0.3,
    while: 0.3,
    with: 0.4,
    match: 0.3,
    case: 0.2,
  },
  commentPrefixes: ["#"],
  // Python docstrings ("""..."""/'''...''') are handled specially in signal.ts
  blockCommentStart: '"""',
  blockCommentEnd: '"""',
  indentWeight: 0.15,
  decoratorWeight: 0.5,
};

const tsConfig: LanguageConfig = {
  name: "typescript",
  extensions: [".ts", ".tsx", ".mts", ".cts"],
  structuralKeywords: {
    ...tsLikeKeywords,
    get: 0.3,
    set: 0.3,
  },
  commentPrefixes: ["//"],
  blockCommentStart: "/*",
  blockCommentEnd: "*/",
  indentWeight: 0.15,
  decoratorWeight: 0.5,
};

const jsConfig: LanguageConfig = {
  name: "javascript",
  extensions: [".js", ".jsx", ".mjs", ".cjs"],
  structuralKeywords: {
    ...jsLikeKeywords,
    get: 0.3,
    set: 0.3,
  },
  commentPrefixes: ["//"],
  blockCommentStart: "/*",
  blockCommentEnd: "*/",
  indentWeight: 0.15,
  decoratorWeight: 0.5,
};

const goConfig: LanguageConfig = {
  name: "go",
  extensions: [".go"],
  structuralKeywords: {
    ...cLikeKeywords,
    func: 0.9,
    go: 0.2,
    defer: 0.2,
    select: 0.2,
    struct: 0.9,
    package: 0.3,
  },
  commentPrefixes: ["//"],
  blockCommentStart: "/*",
  blockCommentEnd: "*/",
  indentWeight: 0.1,
  decoratorWeight: 0.0,
};

const rustConfig: LanguageConfig = {
  name: "rust",
  extensions: [".rs"],
  structuralKeywords: {
    ...cLikeKeywords,
    fn: 0.9,
    impl: 0.9,
    mod: 0.6,
    use: 0.5,
    pub: 0.4,
    mut: 0.1,
    trait: 0.9,
    struct: 0.9,
    enum: 0.8,
    type: 0.5,
    match: 0.3,
    where: 0.2,
    unsafe: 0.3,
    extern: 0.3,
    macro_rules: 0.7,
  },
  commentPrefixes: ["//"],
  blockCommentStart: "/*",
  blockCommentEnd: "*/",
  indentWeight: 0.15,
  decoratorWeight: 0.4,
  // `'a` is a lifetime, not a string delimiter.
  stringDelimiters: ['"'],
};

const javaConfig: LanguageConfig = {
  name: "java",
  extensions: [".java"],
  structuralKeywords: {
    ...tsLikeKeywords,
    package: 0.6,
    extends: 0.5,
    implements: 0.5,
    throws: 0.2,
    synchronized: 0.2,
    volatile: 0.1,
    transient: 0.1,
    native: 0.1,
    strictfp: 0.1,
  },
  commentPrefixes: ["//"],
  blockCommentStart: "/*",
  blockCommentEnd: "*/",
  indentWeight: 0.15,
  decoratorWeight: 0.5,
};

const rubyConfig: LanguageConfig = {
  name: "ruby",
  extensions: [".rb", ".rake", ".gemspec"],
  filenames: ["Rakefile", "Gemfile"],
  structuralKeywords: {
    class: 1.0,
    def: 0.9,
    module: 0.9,
    require: 0.6,
    include: 0.4,
    extend: 0.4,
    private: 0.3,
    protected: 0.3,
    public: 0.3,
    attr_accessor: 0.5,
    attr_reader: 0.5,
    attr_writer: 0.5,
    if: 0.3,
    unless: 0.3,
    else: 0.2,
    elsif: 0.2,
    while: 0.3,
    until: 0.3,
    for: 0.3,
    do: 0.2,
    begin: 0.3,
    rescue: 0.3,
    ensure: 0.2,
    case: 0.2,
    when: 0.2,
    return: 0.2,
    yield: 0.2,
    raise: 0.2,
  },
  commentPrefixes: ["#"],
  blockCommentStart: "=begin",
  blockCommentEnd: "=end",
  indentWeight: 0.12,
  decoratorWeight: 0.0,
  blockCommentAtLineStart: true,
};

const phpConfig: LanguageConfig = {
  name: "php",
  extensions: [".php"],
  structuralKeywords: {
    ...tsLikeKeywords,
    namespace: 0.6,
    use: 0.5,
    trait: 0.8,
    extends: 0.5,
    implements: 0.5,
    require_once: 0.5,
    require: 0.5,
    include: 0.4,
    include_once: 0.4,
    echo: 0.1,
  },
  commentPrefixes: ["//", "#"],
  blockCommentStart: "/*",
  blockCommentEnd: "*/",
  indentWeight: 0.15,
  decoratorWeight: 0.4,
};

const swiftConfig: LanguageConfig = {
  name: "swift",
  extensions: [".swift"],
  structuralKeywords: {
    ...cLikeKeywords,
    func: 0.9,
    guard: 0.3,
    defer: 0.2,
    protocol: 0.9,
    extension: 0.7,
    struct: 0.9,
    actor: 0.9,
    mutating: 0.3,
    nonmutating: 0.3,
    override: 0.3,
    convenience: 0.2,
    required: 0.2,
    weak: 0.1,
    unowned: 0.1,
    throws: 0.2,
    rethrows: 0.2,
    associatedtype: 0.5,
    typealias: 0.4,
  },
  commentPrefixes: ["//"],
  blockCommentStart: "/*",
  blockCommentEnd: "*/",
  indentWeight: 0.15,
  decoratorWeight: 0.4,
};

const kotlinConfig: LanguageConfig = {
  name: "kotlin",
  extensions: [".kt", ".kts"],
  structuralKeywords: {
    ...cLikeKeywords,
    fun: 0.9,
    val: 0.2,
    object: 0.7,
    companion: 0.4,
    data: 0.4,
    sealed: 0.5,
    open: 0.4,
    override: 0.3,
    suspend: 0.3,
    operator: 0.3,
    infix: 0.2,
    inline: 0.2,
    tailrec: 0.2,
    external: 0.2,
    annotation: 0.4,
    expect: 0.3,
    actual: 0.3,
  },
  commentPrefixes: ["//"],
  blockCommentStart: "/*",
  blockCommentEnd: "*/",
  indentWeight: 0.15,
  decoratorWeight: 0.5,
};

const scalaConfig: LanguageConfig = {
  name: "scala",
  extensions: [".scala", ".sc"],
  structuralKeywords: {
    ...cLikeKeywords,
    def: 0.9,
    val: 0.2,
    object: 0.7,
    trait: 0.9,
    sealed: 0.5,
    implicit: 0.4,
    given: 0.3,
    using: 0.3,
    extension: 0.5,
    opaque: 0.3,
    case: 0.4,
    match: 0.3,
    lazy: 0.1,
    override: 0.3,
  },
  commentPrefixes: ["//"],
  blockCommentStart: "/*",
  blockCommentEnd: "*/",
  indentWeight: 0.15,
  decoratorWeight: 0.5,
};

const lispReaderDefaults: Pick<
  LanguageConfig,
  "stringDelimiters" | "backslashCharLiterals" | "family"
> = {
  stringDelimiters: ['"'],
  backslashCharLiterals: true,
  family: "lisp",
};

const clojureConfig: LanguageConfig = {
  name: "clojure",
  extensions: [".clj", ".cljs", ".cljc", ".edn"],
  structuralKeywords: {
    defn: 0.9,
    "defn-": 0.9,
    def: 0.7,
    defmacro: 0.9,
    defmulti: 0.9,
    defmethod: 0.8,
    defprotocol: 0.9,
    defrecord: 0.9,
    deftype: 0.9,
    definterface: 0.9,
    defonce: 0.7,
    "extend-type": 0.8,
    "extend-protocol": 0.8,
    letfn: 0.6,
    reify: 0.6,
    ns: 0.6,
    require: 0.6,
    use: 0.5,
    import: 0.5,
    fn: 0.4,
    let: 0.2,
    if: 0.3,
    when: 0.3,
    loop: 0.3,
    for: 0.3,
    doseq: 0.3,
    try: 0.3,
    catch: 0.3,
    finally: 0.2,
  },
  commentPrefixes: [";"],
  blockCommentStart: "(comment",
  blockCommentEnd: ")",
  indentWeight: 0.12,
  decoratorWeight: 0.0,
  blockCommentUsesParenDepth: true,
  ...lispReaderDefaults,
};

// ─── Scheme / Common Lisp / Emacs Lisp ───────────────────────
//
// Shared reader conventions across the Lisp family: only `"` delimits a
// string (`'` is quote, backtick is quasiquote), a backslash outside a
// string introduces a character literal, and `;` starts a line comment.
// Note the tokenizer in signal.ts splits on `*`, so `let*` / `letrec*`
// arrive as `let` / `letrec` and need no separate entries.

const schemeConfig: LanguageConfig = {
  name: "scheme",
  extensions: [".scm", ".ss", ".sld", ".sls", ".sps", ".rkt"],
  structuralKeywords: {
    define: 0.9,
    "define-syntax": 0.9,
    "define-syntax-rule": 0.9,
    "define-record-type": 0.9,
    "define-struct": 0.9,
    struct: 0.9,
    "define-class": 0.9,
    "define-generic": 0.9,
    "define-method": 0.8,
    "define-macro": 0.9,
    "define-values": 0.7,
    "define-module": 0.6,
    "define-library": 0.6,
    "define-public": 0.9,
    "define-inline": 0.9,
    "define-constant": 0.7,
    "syntax-rules": 0.6,
    "syntax-case": 0.6,
    "let-syntax": 0.4,
    "letrec-syntax": 0.4,
    lang: 0.6,
    module: 0.6,
    library: 0.6,
    "use-modules": 0.6,
    require: 0.6,
    provide: 0.6,
    import: 0.6,
    export: 0.6,
    include: 0.5,
    load: 0.5,
    lambda: 0.4,
    "case-lambda": 0.5,
    let: 0.2,
    letrec: 0.3,
    "let-values": 0.3,
    "receive": 0.3,
    if: 0.3,
    cond: 0.3,
    case: 0.3,
    when: 0.3,
    unless: 0.3,
    do: 0.3,
    begin: 0.2,
    "set!": 0.2,
    guard: 0.3,
    "dynamic-wind": 0.3,
    "with-exception-handler": 0.3,
    "call-with-current-continuation": 0.3,
    "call-with-values": 0.3,
    delay: 0.2,
    "define-record-printer": 0.5,
  },
  commentPrefixes: [";"],
  blockCommentStart: "#|",
  blockCommentEnd: "|#",
  indentWeight: 0.12,
  decoratorWeight: 0.0,
  blockCommentNests: true,
  ...lispReaderDefaults,
};

const lispConfig: LanguageConfig = {
  name: "lisp",
  extensions: [".lisp", ".lsp", ".cl", ".asd"],
  structuralKeywords: {
    defun: 0.9,
    defmacro: 0.9,
    defclass: 1.0,
    defstruct: 0.9,
    defgeneric: 0.9,
    defmethod: 0.8,
    deftype: 0.7,
    defvar: 0.7,
    defparameter: 0.7,
    defconstant: 0.7,
    defsetf: 0.6,
    defpackage: 0.6,
    "in-package": 0.6,
    defsystem: 0.7,
    "define-condition": 0.9,
    "define-modify-macro": 0.6,
    "define-compiler-macro": 0.7,
    "define-symbol-macro": 0.6,
    "define-method-combination": 0.6,
    "define-setf-expander": 0.6,
    require: 0.5,
    "use-package": 0.5,
    export: 0.5,
    import: 0.5,
    declaim: 0.3,
    "eval-when": 0.4,
    lambda: 0.4,
    flet: 0.6,
    labels: 0.6,
    macrolet: 0.6,
    let: 0.2,
    if: 0.3,
    when: 0.3,
    unless: 0.3,
    cond: 0.3,
    case: 0.3,
    ecase: 0.3,
    typecase: 0.3,
    etypecase: 0.3,
    loop: 0.3,
    do: 0.3,
    dolist: 0.3,
    dotimes: 0.3,
    "handler-case": 0.3,
    "handler-bind": 0.3,
    "restart-case": 0.3,
    "unwind-protect": 0.3,
    "ignore-errors": 0.2,
    "with-open-file": 0.3,
    "with-slots": 0.2,
    "with-accessors": 0.2,
    progn: 0.1,
    block: 0.2,
    return: 0.2,
    "return-from": 0.2,
  },
  commentPrefixes: [";"],
  blockCommentStart: "#|",
  blockCommentEnd: "|#",
  indentWeight: 0.12,
  decoratorWeight: 0.0,
  blockCommentNests: true,
  ...lispReaderDefaults,
};

const elispConfig: LanguageConfig = {
  name: "elisp",
  extensions: [".el"],
  structuralKeywords: {
    defun: 0.9,
    defmacro: 0.9,
    defsubst: 0.8,
    defvar: 0.7,
    "defvar-local": 0.7,
    defconst: 0.7,
    defcustom: 0.8,
    defgroup: 0.8,
    defface: 0.7,
    defalias: 0.5,
    "cl-defun": 0.9,
    "cl-defmacro": 0.9,
    "cl-defstruct": 0.9,
    "cl-defgeneric": 0.9,
    "cl-defmethod": 0.8,
    "cl-deftype": 0.7,
    "define-minor-mode": 0.9,
    "define-derived-mode": 0.9,
    "define-generic-mode": 0.9,
    "define-globalized-minor-mode": 0.9,
    "define-advice": 0.7,
    "define-key": 0.3,
    "use-package": 0.7,
    require: 0.6,
    provide: 0.6,
    autoload: 0.5,
    lambda: 0.4,
    let: 0.2,
    if: 0.3,
    when: 0.3,
    unless: 0.3,
    cond: 0.3,
    pcase: 0.3,
    while: 0.3,
    dolist: 0.3,
    dotimes: 0.3,
    "condition-case": 0.3,
    "unwind-protect": 0.3,
    "save-excursion": 0.2,
    "save-restriction": 0.2,
    "with-eval-after-load": 0.5,
    "add-hook": 0.3,
    interactive: 0.2,
  },
  commentPrefixes: [";"],
  // Emacs Lisp has no block comment syntax; `#|` cannot occur in valid
  // elisp so these delimiters are inert but keep the config uniform.
  blockCommentStart: "#|",
  blockCommentEnd: "|#",
  indentWeight: 0.12,
  decoratorWeight: 0.0,
  blockCommentNests: true,
  ...lispReaderDefaults,
};

const genericConfig: LanguageConfig = {
  name: "generic",
  extensions: [],
  structuralKeywords: {},
  commentPrefixes: ["#"],
  blockCommentStart: "/*",
  blockCommentEnd: "*/",
  indentWeight: 0.1,
  decoratorWeight: 0.3,
};

// Ordered by priority — genericConfig (last) is the fallback.
// It must remain last and must not share extensions with preceding configs.
const configs: LanguageConfig[] = [
  pythonConfig,
  tsConfig,
  jsConfig,
  goConfig,
  rustConfig,
  javaConfig,
  rubyConfig,
  phpConfig,
  swiftConfig,
  kotlinConfig,
  scalaConfig,
  clojureConfig,
  schemeConfig,
  lispConfig,
  elispConfig,
  genericConfig,
];

export {
  configs,
  pythonConfig,
  tsConfig,
  jsConfig,
  goConfig,
  rustConfig,
  javaConfig,
  rubyConfig,
  phpConfig,
  swiftConfig,
  kotlinConfig,
  scalaConfig,
  clojureConfig,
  schemeConfig,
  lispConfig,
  elispConfig,
  genericConfig,
};

export function detectLanguage(filename: string): LanguageConfig {
  const slash = Math.max(filename.lastIndexOf("/"), filename.lastIndexOf("\\"));
  const basename = slash >= 0 ? filename.slice(slash + 1) : filename;
  for (const cfg of configs) {
    if (cfg.filenames?.includes(basename)) return cfg;
  }
  const dot = basename.lastIndexOf(".");
  const ext = dot >= 0 ? basename.slice(dot).toLowerCase() : "";
  if (ext) {
    for (const cfg of configs) {
      if (cfg.extensions.includes(ext)) return cfg;
    }
  }
  return genericConfig;
}
