# Ordo

Osobní seznam, nástěnka a poznámky v jednom. Jedna položka má jednu domovskou složku a může se objevit v dnešku, nákupu i u člověka.

## Spuštění

Projekt používá Node.js 26. Je doporučeno použít [nvm](https://github.com/nvm-sh/nvm):

```bash
nvm install
nvm use
```

Pro instalaci závislostí používej npm:

```bash
npm install
npm run dev
```

Aplikace běží na http://localhost:5177. Data zůstávají v tomhle prohlížeči (IndexedDB). Zálohu stáhneš v Nastavení jako JSON a stejnou cestou ji zase načteš.

## Hlasová zkratka

Otevři `/add?text=…`. První řádek je název, zbytek popis. Volitelně `folder` a `due=RRRR-MM-DD`.

## Časová osa

Každá složka i Kalendář umí kromě měsíce zobrazit Ganttův diagram. Každý úkol je pruh: plán od–do přes více dní, termín nebo plán na jeden den přes jeden den. Vazby „čeká na“ jsou šipky. Milníky jsou samostatná data, ne úkoly, a táhnou se svislou čárou přes celý diagram.

- Pruh posuneš tažením, délku změníš tažením za okraj. Natažením jednodenního úkolu s termínem vznikne plán od–do. Po posunu se nabídne posun navazujících úkolů o stejný počet dní.
- Šipku natáhneš z kolečka před pruhem nebo za ním, nebo tažením pruhu s klávesou Alt. Kliknutím na šipku ji odebereš.
- Tažením v řádku Nový úkol vznikne úkol od–do, kliknutím úkol na jeden den. Tažením nebo kliknutím v řádku úkolu bez termínu ho naplánuješ.
- Milník přidáš kliknutím do pásu Milníky pod datem. Tažením ho posuneš, kliknutím přejmenuješ, změníš datum nebo smažeš. Milník ve složce patří jí a jejím podsložkám, milník přidaný v Kalendáři je vidět všude.
- Od–do jde nastavit i v detailu úkolu v části Kdy.
- Pořadí řádků změníš tažením za úchyt vlevo od názvu. Podúkoly se přesouvají jen mezi sourozenci a rodič je bere s sebou. Ruční pořadí platí jen pro časovou osu, seznam ho nemění.
- Šířku sloupce s úkoly změníš tažením za jeho pravý okraj.
- Úkol i milník mají barvu složky. Vlastní barvu nastavíš v detailu úkolu (Barva) nebo v editoru milníku. Složka bez barvy nechá pruh neutrální. Barvu člověka, kterou má jeho kolečko u úkolů, nastavíš na jeho stránce v Lidech.
- Při tažení šipky se cílový úkol zvýrazní a šipka se ukáže tam, kam dopadne. Vazba, která by vytvořila kruh nebo už existuje, svítí červeně.
- Měřítko mění sevření prstů, Ctrl + kolečko nebo tlačítka lupy. Na dotykové obrazovce se pruh chytá podržením prstu.

## Synchronizace

Evolu se zatím nezapíná. Až přijde na řadu, nahradí se modul `src/data/store.tsx`. Rozhraní dál čte stejný snímek a zapisuje stejné operace.

## Google Kalendář

Ordo čte události ze všech tvých kalendářů a ukáže je v kalendáři a v přehledu Dnes. Úkoly s termínem nebo plánem zapisuje do vlastního kalendáře „Ordo“, který si samo založí. Ten se synchronizuje oběma směry:

- Změna názvu, termínu, priority nebo popisu v Ordo se propíše do Googlu. Hotový úkol dostane fajfku, smazaný nebo zrušený úkol událost ztratí.
- Přejmenování nebo posun události v Googlu se vrátí do úkolu. Smazání události přesune úkol do koše.
- Když se mezi dvěma synchronizacemi změní obě strany, vyhraje novější změna.

Připojení, mezipaměť událostí i stav synchronizace patří vždy jednomu zařízení. Do zálohy ani do Evolu se nic z Googlu nedostane.

Přihlášení obsluhuje Vercel funkce `api/gcal/[op].js`. Refresh token drží zašifrovaný v httpOnly cookie a prohlížeč od ní dostává jen hodinový přístupový token. Ordo žádá čtení všech kalendářů a zápis jen do kalendářů, které samo vytvořilo.

### Nastavení

1. V [Google Cloud Console](https://console.cloud.google.com/) založ projekt a zapni Google Calendar API.
2. Otevři Google Auth Platform. Když vidíš jen tlačítko Get started, projdi nejdřív úvodní nastavení: název aplikace, e-mail, publikum Externí a kontakt. V části Audience se přidej jako testovacího uživatele.
3. V levém menu Google Auth Platform otevři Data Access a klikni na Add or remove scopes. V panelu vyfiltruj „calendar“ a zaškrtni oba scopy níže. Když v seznamu nejsou, vlož je do pole Manually add scopes dole v panelu a klikni na Add to table. Pak Update a nakonec Save.

   ```
   https://www.googleapis.com/auth/calendar.readonly
   https://www.googleapis.com/auth/calendar.app.created
   ```

4. V Clients vytvoř klienta typu Web application a povol tyto redirect URI:
   - `https://<tvoje-doména>/api/gcal/callback`
   - `http://localhost:5177/api/gcal/callback`
5. Ve Vercelu nastav proměnné prostředí a nasaď znovu:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GCAL_COOKIE_SECRET`, volitelný náhodný řetězec. Bez něj se klíč cookie odvodí z client secret.
6. Lokálně dej stejné proměnné do `.env.local` a spusť `npm run dev`. Dev server obslouží `/api/gcal/*` sám.
7. V Ordo otevři Nastavení a klikni na Připojit Google Kalendář.

V režimu Testing vydává Google refresh token jen na 7 dní, potom je potřeba se připojit znovu. Po přepnutí aplikace do produkce (Publish app) token nevyprší. Google pak při připojení jednou ukáže varování o neověřené aplikaci.
