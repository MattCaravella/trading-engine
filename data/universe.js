/**
 * Stock universe — S&P 500 + high-momentum names
 * Used by all strategies for broad scanning
 */

const SP500 = [
  // Technology
  'AAPL','MSFT','NVDA','META','GOOGL','GOOG','AMZN','TSLA','AVGO','ORCL',
  'AMD','QCOM','TXN','INTC','MU','AMAT','LRCX','KLAC','ADI','MCHP',
  'CRM','NOW','ADBE','INTU','SNOW','PLTR','PANW','CRWD','ZS','NET',
  'CSCO','IBM','HPE','DELL','ANET','MRVL','SMCI','WDAY','DDOG','GTLB',
  'TTD','HUBS','OKTA','MNDY','CFLT','MDB','ESTC','TEAM','COUP','ZM',
  'DOCU','BOX','TWLO','RAMP','BILL','SMAR','APPN','NCNO','AI','PATH',
  'COIN','HOOD','SOFI','UPST','AFRM','LCID','RIVN','PLUG','FCEL','BLNK',
  // Financials
  'JPM','BAC','GS','MS','WFC','C','BLK','SCHW','AXP','V','MA','PYPL',
  'COF','DFS','SYF','ALLY','RF','USB','TFC','KEY','MTB','FITB','HBAN',
  'CFG','ZION','CMA','PBCT','SIVB','SBNY','WAL','PACW','FRC','IBKR',
  'ICE','CME','CBOE','NDAQ','MKTX','HOOD',
  // Healthcare
  'UNH','LLY','JNJ','ABBV','MRK','PFE','TMO','ABT','DHR','BMY',
  'AMGN','GILD','REGN','VRTX','BIIB','MRNA','BNTX','ILMN','IQV','CRL',
  'CAH','MCK','CVS','CI','HUM','ELV','MOH','CNC','HCA','UHS',
  'STE','WST','HOLX','HOLOGIC','BAX','BDX','MDT','SYK','BSX','ZBH',
  // Consumer Discretionary
  'HD','LOW','MCD','SBUX','NKE','TJX','ROST','BURL','M','KSS',
  'TGT','WMT','COST','DG','DLTR','AMZN','EBAY','ETSY','W','CHWY',
  'F','GM','TSLA','RIVN','LCID','RACE','HOG','LEA','BWA','AZO',
  'AAP','ORLY','GPC','LKQ','AN','KMX','LAD','PAG','SAH',
  // Industrials
  'BA','CAT','GE','MMM','HON','RTX','LMT','NOC','GD','L3H',
  'UPS','FDX','DAL','UAL','AAL','LUV','JBLU','ALK','SAVE',
  'DE','EMR','ETN','PH','ROK','AME','FTV','GNRC','XYL','XYLEM',
  'WM','RSG','CTAS','FAST','GWW','MSC','TT','IR','CARR','OTIS',
  // Energy
  'XOM','CVX','COP','EOG','PXD','MPC','VLO','PSX','OXY','DVN',
  'HAL','SLB','BKR','NOV','FANG','CLR','APA','MRO','HES','CTRA',
  'LNG','CQP','KMI','WMB','OKE','ET','EPD','PAA','TRGP','ENBL',
  // Consumer Staples
  'PG','KO','PEP','MDLZ','GIS','K','CPB','CAG','HRL','MKC',
  'CL','CHD','SPB','CLX','EL','ULTA','COTY','REV','AVP',
  'PM','MO','BTI','LO','STZ','BUD','TAP','SAM','BREW',
  // Real Estate / Utilities / Materials
  'AMT','PLD','EQIX','CCI','SPG','O','WELL','DLR','PSA','EXR',
  'NEE','DUK','SO','AEP','EXC','XEL','ED','PCG','SRE','WEC',
  'LIN','APD','ECL','SHW','PPG','NEM','FCX','AA','CLF','X','NUE',
  // Communications
  'NFLX','DIS','CMCSA','T','VZ','TMUS','CHTR','DISH','PARA','FOX',
  'SPOT','SNAP','PINS','RDDT','MTCH','IAC','ZG','TRIP','BOOKING','EXPE',
  // ETFs (sector proxies — useful for pairs/macro signals)
  'SPY','QQQ','IWM','DIA','XLK','XLF','XLE','XLV','XLI','XLP','XLU','XLRE','XLB','XLC','XLY',
  'GLD','SLV','USO','TLT','HYG','IEF','EEM','EFA','VNQ','ARKK','ARKG','ARKW'
];

// Deduplicate
const UNIVERSE = [...new Set(SP500)];

module.exports = { UNIVERSE };
