#!/bin/bash
# W4-Fixture fuer bench.ts: erzeugt ein Wegwerf-Repo mit bekannten Sollwerten.
# Aufruf: bash fixture.sh <zielordner>   (der Ordner wird GELOESCHT und neu angelegt)
#
# Kontrollwerte (vorab fest, bench.ts AUFGABEN muss dieselben tragen):
# alpha: TODO 3, Code A-4417 · beta: TODO 5, Code B-9062 · gamma: TODO 2, Code G-1385
# delta: Testfehler in add(); nach Fix Code D-7720 · epsilon: scheitert beim 1. Lauf (Netz), 2. Lauf E-3051
set -e
Z="${1:?Aufruf: fixture.sh <zielordner>}"; rm -rf "$Z"; mkdir -p "$Z"; cd "$Z"; git init -q
mk() { # name todo code dauer
  mkdir -p "$1/src"
  for i in $(seq 1 $2); do echo "// TODO($1): Punkt $i" >> "$1/src/main.js"; done
  echo "module.exports = { name: '$1' };" >> "$1/src/main.js"
  printf '#!/bin/bash\n# Prüfung des Pakets %s (dauert ~%ss)\nsleep %s\necho "ERGEBNIS %s %s"\n' "$1" "$4" "$4" "$1" "$3" > "$1/pruefe.sh"
  chmod +x "$1/pruefe.sh"
}
mk alpha 3 A-4417 45; mk beta 5 B-9062 50; mk gamma 2 G-1385 40
mkdir -p delta/src
cat > delta/src/rechne.js <<'J'
function add(a, b) { return a - b; } // Fehler: muss a + b sein
module.exports = { add };
J
cat > delta/pruefe.sh <<'J'
#!/bin/bash
sleep 20
r=$(node -e "console.log(require('./src/rechne.js').add(2,3))")
if [ "$r" = "5" ]; then echo "ERGEBNIS delta D-7720"; else echo "FEHLER delta: add(2,3)=$r statt 5"; exit 1; fi
J
chmod +x delta/pruefe.sh
mkdir -p epsilon/src; echo "// TODO(epsilon): Punkt 1" > epsilon/src/main.js
cat > epsilon/pruefe.sh <<'J'
#!/bin/bash
sleep 15
if [ ! -f .erster-lauf ]; then touch .erster-lauf; echo "FEHLER epsilon: Netzwerk nicht erreichbar (vorübergehend)"; exit 1; fi
echo "ERGEBNIS epsilon E-3051"
J
chmod +x epsilon/pruefe.sh
git add -A && git -c user.email=b@b -c user.name=b commit -qm fixture
