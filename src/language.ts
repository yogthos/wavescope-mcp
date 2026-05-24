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
