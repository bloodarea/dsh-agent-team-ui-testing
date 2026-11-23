    /**
     * 视图注册表：把「环境 id → 视图实现」做成一张表加三个查询。
     *
     * 公共外壳不 import 任何环境的视图代码，只通过这张表组合；一个环境要接入面板，只需把一个
     * 渲染函数登记进自己的注册项（web 目前是唯一实现，其余环境落到公共空白画布）。
     */
    function createViewRegistry(views) {
      const table = views && typeof views === 'object' ? views : {};
      const lookup = (id) => {
        const key = typeof id === 'string' ? id : '';
        return key && typeof table[key] === 'function' ? table[key] : null;
      };
      return {
        ids() { return Object.keys(table).filter((key) => typeof table[key] === 'function'); },
        has(id) { return lookup(id) !== null; },
        render(id) {
          const view = lookup(id);
          return view ? view() : null;
        },
        // 无视图环境：外壳自己渲染公共空白画布，绝不借用别的环境的正文。
        renderOr(id, fallback) {
          const view = lookup(id);
          return view ? view() : (typeof fallback === 'function' ? fallback() : null);
        },
      };
    }
