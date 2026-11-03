(function () {
  var style = getComputedStyle(document.documentElement);
  var bg = style.getPropertyValue('--bg').trim();
  var bg2 = style.getPropertyValue('--bg2').trim();
  var ink = style.getPropertyValue('--ink').trim();
  var muted = style.getPropertyValue('--muted').trim();
  var rule = style.getPropertyValue('--rule').trim();
  var accent = style.getPropertyValue('--accent').trim();
  var accent2 = style.getPropertyValue('--accent2').trim();

  mermaid.initialize({
    startOnLoad: false,
    theme: 'base',
    securityLevel: 'loose',
    fontFamily: "'Instrument Sans', 'PingFang SC', 'Hiragino Sans GB', 'Noto Sans SC', sans-serif",
    themeVariables: {
      background: bg,
      mainBkg: bg2,
      primaryColor: bg2,
      primaryTextColor: ink,
      primaryBorderColor: rule,
      secondaryColor: bg2,
      tertiaryColor: bg,
      nodeBorder: rule,
      nodeTextColor: ink,
      lineColor: accent2,
      textColor: ink,
      clusterBkg: bg,
      clusterBorder: rule,
      titleColor: ink,
      edgeLabelBackground: bg2,
      fontSize: '14px'
    },
    flowchart: {
      curve: 'basis',
      htmlLabels: true,
      padding: 14,
      nodeSpacing: 30,
      rankSpacing: 46,
      useMaxWidth: false
    },
    er: {
      useMaxWidth: false
    }
  });

  mermaid.run({ querySelector: '.mermaid' }).catch(function (err) {
    console.error('Mermaid render failed:', err);
  });
})();
