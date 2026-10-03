# Bitácora de digitalización

Bitácora de digitalización de documentos. Registra la recepción y el
seguimiento de los documentos que entran a digitalización: quién entrega, quién
recepciona, de qué dependencia, cuántos documentos, cuántas fojas y en qué
situación se reciben; el avance de la captura, las incidencias del servicio y
la devolución con su punto de aceptación.

**Manual para el personal:** [docs/guia-rapida.md](docs/guia-rapida.md), una
guía corta por puesto (Mesa, Recepción, Operador y Supervisor); también en
[PDF con imágenes](docs/guia-rapida.pdf) para imprimir.

**Flujo de operación en BPMN 2.0:** [docs/flujo-operacion.bpmn](docs/flujo-operacion.bpmn)
(se abre en Camunda Modeler o en <https://demo.bpmn.io>), con su imagen en
[PNG](docs/flujo-operacion.png) y [SVG](docs/flujo-operacion.svg).

## Requisitos

Solo Node.js 24 o superior. No hay dependencias externas: la base de datos es
SQLite integrado en Node (`node:sqlite`, que deja de ser experimental en la 24)
y la interfaz es HTML, CSS y JS puros.

## Qué guarda y qué no

La base de datos registra el proceso: quién entregó qué, en qué estado, quién
lo digitalizó y cómo se devolvió. Es pequeña: unos 2 KB por remisión, o 90 KB si
lleva las cuatro firmas.

Los **expedientes digitales** (el PDF de cada carpeta) **no van dentro de la
base**: se guardan como archivos en una carpeta aparte, que puede ser una NAS
(ver *Expedientes digitales y NAS*).

## Arrancar

```bash
npm start
```

Al iniciar, la consola imprime dos direcciones:

```
Bitácora de digitalización  ·  este equipo:  http://localhost:4321
                      ·  en la red:    http://192.168.68.124:4321
```

La primera es para el equipo donde corre el sistema. **La segunda es la que se
abre desde los demás equipos de la oficina** — computadoras, tabletas o
teléfonos — en cualquier navegador. No hay que instalar nada en ellos.

**El sistema no atiende a nadie mientras no esté configurado el acceso con Google**
(siguiente sección): cada registro tiene que quedar a nombre de una persona
verificada. Para conocerlo antes de configurar Google, usa `npm run prueba`.

Para que funcione: el equipo servidor debe estar encendido, en la misma red, y
macOS debe permitir conexiones entrantes a Node (la primera vez aparece un
aviso del cortafuegos; hay que aceptarlo). Si la IP del equipo cambia, la
dirección cambia con ella; conviene pedirle al router una IP fija.

Para cambiar el puerto: `PORT=8080 npm start`.

## Pruebas

```bash
npm test
```

Usa el ejecutor de pruebas que trae Node (`node:test` y `node:assert`), sin
dependencias. Las pruebas van en `test/` con nombre `*.test.js`.
`test/entorno.js` se carga antes que todas y apunta la base a memoria y los
expedientes y respaldos a una carpeta temporal: **las pruebas nunca tocan
`data/`**. `test/integracion.test.js` arranca además su propio servidor en un
puerto libre y recorre el flujo completo (`test/flujo-completo.mjs`): mesas,
traslados, solicitudes, devolución y permisos por rol. Para ver la cobertura:
`node --test --experimental-test-coverage --import ./test/entorno.js "test/**/*.test.js"`.

## Acceso con Google

Cada persona entra con su cuenta de Google y solo pueden entrar los correos
dados de alta. **Es obligatorio**: como se trata de carpetas de investigación,
todo lo que se registra —recibir, validar, preparar, escanear, recoser,
devolver, aprobar— queda a nombre de una persona verificada, y el servidor
nunca acepta del navegador el nombre de quien hace algo.

Ya no existe el «modo local» en el que cada equipo declaraba quién lo usaba.

### Probarlo antes de configurar Google

Para conocer el sistema con sesiones reales sin haber creado todavía las
credenciales:

```bash
npm run prueba
```

Arranca con una **entrada de prueba** y **con su propia base**
(`data/prueba.db`, respaldos en `data/respaldos-prueba/`), así que nada de lo
que se haga ahí se mezcla con los datos reales. La pantalla de acceso ofrece tres
cuentas ficticias —dos supervisores, Operador, Recepción, una persona de la
*Mesa 1* y Recepción de una segunda sede (*Sede Norte*)— para entrar con un clic y
ver cómo cambia el sistema según el rol. Dentro aparece un aviso permanente de
que estás en modo de prueba.

El historial atribuye cada movimiento a la cuenta de prueba con la que
entraste. Hay dos supervisores porque una solicitud la tiene que aprobar alguien
distinto de quien la pidió.

Salvaguardas, para que esto no se convierta en una puerta trasera:

- solo funciona con `BITACORA_ACCESO_PRUEBA=1`; sin esa variable la ruta no
  existe, aunque las cuentas sigan en la base;
- solo admite cuentas del dominio ficticio `prueba.local`, así que nunca sirve
  para entrar como una persona real, ni siquiera dada de alta;
- las cuentas se crean una sola vez, y únicamente si no hay nadie dado de alta;
- la consola avisa en cada arranque que la entrada está encendida.

**Antes de usar el sistema con documentos reales, arranca con `npm start`** (sin
la variable) y da de alta a las personas con sus correos de Google. Las cuentas
de prueba se pueden quitar desde *Personas con acceso*.

### 1. Crear las credenciales en Google

En <https://console.cloud.google.com>:

1. Crea un proyecto (por ejemplo *Bitácora*).
2. **APIs y servicios → Pantalla de consentimiento de OAuth**. Si la empresa
   tiene Google Workspace, elige **Interno**: solo entrarán cuentas del
   dominio. Si usan cuentas de Gmail sueltas, elige **Externo** y agrega a cada
   persona como usuario de prueba, o publica la aplicación.
3. **Credenciales → Crear credenciales → ID de cliente de OAuth →
   Aplicación web**.
4. En **URI de redireccionamiento autorizados** agrega exactamente la
   dirección del sistema seguida de `/auth/google/callback`. Por ejemplo:

   ```
   http://localhost:4321/auth/google/callback
   ```

5. Copia el **ID de cliente** y el **secreto de cliente**.

### 2. Arrancar con el acceso activo

```bash
GOOGLE_CLIENT_ID="...apps.googleusercontent.com" \
GOOGLE_CLIENT_SECRET="..." \
BITACORA_URL="http://localhost:4321" \
npm start
```

`BITACORA_URL` debe ser **idéntica** a la dirección que registraste en Google;
de ahí se construye la URI de redireccionamiento. La consola la imprime al
arrancar para que puedas compararla.

Para no escribir las variables cada vez, ponlas en un archivo y cárgalo, o
créate un guion de arranque. **El secreto de cliente no debe subirse a ningún
repositorio.**

Variables opcionales:

| Variable | Para qué |
|---|---|
| `BITACORA_ACCESO_PRUEBA` | `1` enciende la entrada de prueba sin Google |
| `BITACORA_DOMINIO` | Limita el acceso a un dominio de Workspace (`empresa.com`) |
| `BITACORA_HORAS_SESION` | Duración de la sesión; por omisión 12 horas |
| `BITACORA_TLS_CERT` y `BITACORA_TLS_KEY` | Rutas al certificado y la llave, para servir por HTTPS |

### 3. La primera entrada

La **primera cuenta que entra queda como Supervisor**, porque la lista está
vacía y alguien tiene que poder administrarla. A partir de ahí nadie más entra
solo: un supervisor da de alta cada correo desde *Personas con acceso* (el
selector de identidad de la barra lateral). Quien no esté en la lista recibe un
mensaje claro y no pasa.

Los supervisores son los únicos que pueden dar de alta, cambiar roles o quitar
accesos, y nadie puede darse de baja a sí mismo.

### Dónde se complica: la red local

Google **solo acepta `http://` cuando el destino es `localhost`**. Cualquier
otra dirección debe ser `https://` con un nombre de dominio; una IP privada
como `http://192.168.68.124:4321` es rechazada al registrarla.

Es decir: **el acceso con Google y el uso en la red local por `http://` son
incompatibles.** Hay tres caminos:

1. **Un solo equipo.** Todos capturan en la máquina donde corre el sistema,
   entrando por `http://localhost:4321`. El acceso con Google funciona sin
   nada más. Es lo más simple, pero se pierde el trabajo simultáneo.
2. **Red local con HTTPS y dominio propio** (recomendado si quieren ambas
   cosas). Se necesita un dominio y un certificado:
   - crea un registro DNS, por ejemplo `bitacora.tuempresa.com`, apuntando a
     la IP privada del equipo servidor;
   - emite un certificado con Let's Encrypt por validación DNS (no hace falta
     exponer nada a internet);
   - arranca con `BITACORA_TLS_CERT`, `BITACORA_TLS_KEY` y
     `BITACORA_URL="https://bitacora.tuempresa.com:4321"`, y registra esa
     misma dirección en Google.

   El sistema sigue siendo inalcanzable desde fuera de la oficina, pero ya
   habla HTTPS y Google lo acepta.
3. **Publicarlo en internet** con dominio y HTTPS. Funciona desde cualquier
   lado, pero expone el sistema; antes de eso conviene revisar respaldos,
   límites de intentos y registro de accesos.

Mientras se trabaje por `http://` en la red, el tráfico viaja sin cifrar:
alguien conectado a la misma red podría leer los datos e incluso reutilizar la
cookie de sesión. Es un riesgo bajo en una oficina con red propia, y desaparece
con HTTPS.

## Devueltas

La vista **Devueltas** es el registro de las carpetas: qué está en nuestro poder
y qué ya se devolvió. Tiene tres pestañas —*En resguardo*, *Devueltas* y
*Todas*— y arriba, cuatro cifras: lotes en resguardo con sus cajas, cuántos ya
están digitalizados esperando devolución, cuántos se entregaron, y **cuántos
acuses quedaron pendientes** de cotejo o de firma.

De cada lote en resguardo se ve **cuántos días lleva** en nuestro poder, su
avance de digitalización y qué le falta para cerrarse; de los entregados, la
fecha de devolución, los archivos entregados, el medio y el punto de
aceptación. Un clic abre el lote directo en su pestaña de *Devolución*.

### Registrar una salida

El botón **Registrar salida** —o el atajo en cada lote listo para entregar—
abre el registro completo de la salida sin tener que entrar al lote:

- se elige el lote y aparece su resumen: documentos, fojas, cajas, imágenes
  generadas y la fecha en que se recibió;
- se listan **las incidencias que arrastra**, con un aviso si sale con alguna
  sin resolver, porque quedan asentadas en el acuse de devolución;
- se capturan los datos de la entrega y el punto de aceptación;
- y si al preparar la salida **se detecta algo** —una caja con humedad, un
  expediente que no aparece al empacar— se marca la casilla y se levanta la
  incidencia ahí mismo, sin salir del formulario.

Al guardar, el lote pasa a *Devuelto* y el sistema lleva directo al cotejo, que
es lo que falta para poder firmar el acuse.

### Cotejo de la devolución

La devolución se coteja **con la misma estructura de cajas que la recepción**.
Cada caja muestra cuántas fojas se recibieron y cuántas salen, y cada carpeta
viene precargada con lo asentado al recibirla: cantidad, fojas y **situación**.
Quien coteja confirma cada caja con *Sale igual que se recibió* o corrige solo lo
que cambió. Cualquier diferencia —una carpeta que falta, fojas de menos o una
carpeta que sale en otra situación, por ejemplo «Buen estado → Húmedo o
manchado»— se marca en rojo y obliga a escribir la nota.

El acuse de devolución lista las carpetas por caja con lo recibido y lo devuelto,
y en la columna *Condición al devolver* dice «Sin cambios» o qué cambió. Si la devolución se cancela después,
el lote **regresa al estado que le corresponde** según su avance de captura: no
se queda marcado como devuelto estando en resguardo.

## Tablero para la dependencia

Cada dependencia puede consultar el avance de **sus** documentos desde un
enlace propio, sin cuenta ni contraseña. En el panel, la tarjeta *Dependencias*
tiene un botón **Tablero** por cada una: ahí se copia el enlace, se genera uno
nuevo o se desactiva.

El tablero muestra, del lado de la dependencia: cuántas entregas ha hecho, con
cuántas cajas, carpetas y fojas; cuántas imágenes se han generado; y la lista
de sus lotes con **la fecha en que se recibió cada uno y el estado en que va**.

**Por confidencialidad, el tablero solo muestra cifras**: nunca NUC, ni
descripciones de carpetas, ni el texto de las incidencias (solo su tipo y
gravedad).

**Sobre el enlace.** La llave es larga y aleatoria, y solo sirve para esa
dependencia: no hay forma de ver los lotes de otra. El tablero es de solo
lectura y no expone firmas, notas internas ni el historial de auditoría. Aun
así, quien tenga el enlace puede abrirlo, así que compártelo solo con la
dependencia; si se filtra, *Generar enlace nuevo* invalida el anterior en el
momento.

## Personal

La vista **Personal** es el padrón de quienes trabajan en la bitácora: quiénes
reciben documentos y quiénes los digitalizan. De cada persona se guarda nombre,
rol (Recepción, Operador o Supervisor), cargo, correo y teléfono, y se ve de un
vistazo lo que ha hecho: **recepciones atendidas, carpetas escaneadas como
responsable de mesa, imágenes generadas y su última actividad**.

En la misma vista están las **mesas de digitalización**. Cada mesa tiene **un
escaneador** (su responsable) y **preparadores**: las personas con rol *Mesa*
asignadas a ella. Solo un supervisor las da de alta o cambia su escaneador; una
mesa con carpetas en proceso no se puede desactivar.

El cargo importa porque es el que se imprime en los acuses junto a la firma.

En el formulario de recepción, **quién recibe se elige de este padrón** en vez
de escribirse a mano, y el cargo se llena solo. Así el dato queda consistente y
los contadores cuadran. Para casos sueltos —alguien que recibe una sola vez—
está la opción *Otra persona…*, que abre un campo libre.

Dos detalles pensados para no perder historial:

- **Corregir un nombre no reescribe la auditoría.** Las recepciones e
  incidencias pasan al nombre corregido, pero la bitácora de auditoría conserva
  lo que se asentó en su momento y suma un registro del cambio de nombre.
- **Nadie se borra del padrón.** *Dar de baja* quita el acceso y saca a la
  persona de los selectores, pero su historial queda intacto y la baja queda
  registrada. Solo un supervisor da de baja, y nadie a sí mismo.

## Qué se registra

**Por remisión (la entrega física de un lote)**

| Campo | Descripción |
|---|---|
| Folio | Automático y consecutivo por año: `BIT-2026-0001`. El prefijo se define en Ajustes |
| Fecha y hora | Momento de la recepción |
| Dependencia / Área | Origen de los documentos |
| Quién entrega | Nombre y cargo |
| Quién recepciona | Nombre y cargo |
| Estado del lote | Recibido → En digitalización → Digitalizado → Devuelto |
| Observaciones | Condiciones de la entrega, faltantes, acuerdos |

**Por caja y por carpeta de investigación**

La entrega se captura caja por caja. Dentro de cada caja, cada carpeta lleva:

- **NUC** (obligatorio, se guarda en mayúsculas). Si ese NUC ya está registrado
  en otro lote, el formulario lo avisa —puede ser un tomo distinto o una carpeta
  que vuelve—, pero no lo impide.
- **Folio inicial y folio final.** Con el rango, las fojas se calculan solas.
  Si las fojas asentadas no coinciden con el rango (folios *bis*, saltos de
  numeración), se puede guardar, pero **hay que explicarlo en observaciones**.
  Una carpeta marcada como *Sin foliar* no lleva rango.
- Fojas, situación en que se entrega (buen estado, deteriorado, incompleto,
  húmedo o manchado, roto o frágil, empastado, con grapas o clips, foliado, sin
  foliar), descripción (tomo, delito…) y observaciones.

Cada caja muestra al momento cuántas carpetas y fojas lleva, y al pie van los
totales de la entrega. Los totales de cajas, carpetas y fojas **se calculan de
lo capturado** —no se escriben a mano—, así que siempre cuadran con el detalle.
Al capturar, *Enter* en las observaciones pasa a la siguiente carpeta.

El acuse lista las carpetas por caja con su NUC, folios y subtotal, se imprime
una etiqueta por caja con lo que contiene, y la validación y el cotejo de la
devolución se hacen carpeta por carpeta.

## El ciclo completo de un lote

El estado del lote **lo mueve solo el flujo**; no hay botones para cambiarlo a mano:

| Estado | Cuándo cambia |
|---|---|
| **Recibido** | Al registrar la recepción |
| **En digitalización** | Cuando la primera carpeta se asigna a una mesa |
| **Digitalizado** | Cuando la última carpeta queda recosida y verificada |
| **Devuelto** | Al registrar la devolución **aceptada** (una rechazada no cuenta) |
| **Cancelado** | Al cancelar la recepción, con su motivo |

### Validar antes de tocar nada

Ninguna carpeta se puede asignar a una mesa mientras la recepción no esté **validada**:
alguien tiene que contar el lote contra lo asentado (ver *Cotejo*, más abajo).
En cuanto empieza la digitalización, la validación y los datos de la recepción
quedan cerrados.

### Digitalización, carpeta por carpeta

Todo el tratamiento ocurre **en la mesa**. El menú **Digitalización** reúne el
trabajo de todas las mesas:

- **Lotes sin validar**, con un enlace para validarlos: hasta entonces sus
  carpetas no pueden ir a una mesa.
- **Por asignar a mesa**: las carpetas de los lotes validados, agrupadas por
  lote y por caja. **Una caja va entera a una sola mesa**: se marca la caja
  (o el lote completo, o *Seleccionar todas las cajas*) y con ella van todas
  sus carpetas pendientes; las carpetas no se marcan sueltas. Al marcar una
  caja aparece arriba la barra para elegir la mesa y **Asignar a la mesa**. El
  servidor rechaza una caja incompleta. Si una carpeta regresa por escaneo
  incompleto, se reasigna marcando su caja.
- **Una tarjeta por mesa**, con su escaneador, sus preparadores y sus carpetas.
  Cada carpeta dice a quién le toca el siguiente paso; desde una cuenta de mesa
  cada persona ve **solo el botón de su paso**.

Cada carpeta avanza **en orden, sin saltarse pasos**, con persona, fecha y hora
en cada uno:

1. **Asignar a mesa.** Queda registrado el responsable de la mesa en ese
   momento (si después cambia, el historial no cambia).
2. **Descoser y revisar** (*En mesa*). Se confirma que se retiró el estambre,
   que los folios están completos y en orden, y se escriben las fojas contadas:
   si no coinciden con las asentadas, **la carpeta no avanza** y hay que
   reportar una incidencia. Aquí se registra cada **post-it o documento suelto**
   que se retira: qué es, **en qué hoja** estaba (su número de folio) y **de qué
   lado**: al frente, al reverso o suelto entre esa hoja y la siguiente. Lo hace
   cualquier persona de la mesa y queda registrada como **quien la preparó**. Si
   anota **hojas dañadas**, se abre sola una incidencia *Documento en mal estado*
   para el supervisor; la carpeta sigue su proceso.
3. **Registrar escaneo** (*Descosida*). Desde una mesa, **solo su escaneador**
   escanea y sube el PDF. Fojas escaneadas e imágenes generadas.
   Si no coinciden con las fojas de la carpeta, hay que explicarlo y **la
   carpeta regresa a «Por asignar»** para escanearse de nuevo (no se vuelve a
   descoser).
4. **Reintegrar y recoser** (*Escaneada*). Hay que confirmar, uno por uno, que
   **cada inserto volvió a su hoja y a su lado**, que la carpeta conserva todas sus
   fojas y que se volvió a coser. Si falta confirmar un solo post-it, no se
   registra. Desde una mesa, **solo la recose quien la descosió**; si esa persona
   falta, un supervisor usa **Reasignar recosido** para pasarla a otra persona de
   la misma mesa, con su motivo registrado.

Lo mismo se puede hacer desde la pestaña *Digitalización* de cada lote, donde
el botón **Trazabilidad** de cada carpeta muestra toda su historia en orden.

### Incidencias

En la pestaña *Incidencias* se registra cualquier problema del servicio:
faltantes respecto al inventario, documentos en mal estado o ilegibles, daños
ocurridos en el proceso, errores de foliación, fallas de equipo o documentos
fuera de orden. Cada una lleva gravedad (baja, media, alta), quién la reportó y
cuándo.

Una incidencia **no se borra**: si se registró por error se **anula**, con su
motivo y a nombre de quien la anula, y queda tachada a la vista.

Una incidencia queda **Abierta** hasta que se registra cómo se resolvió. Los
lotes con incidencias abiertas se marcan en la lista de la bitácora y en el
panel, y todas las incidencias —abiertas y resueltas— aparecen en el acuse de
devolución.

### Cotejo: validar lo que se recibe y lo que se entrega

El sistema pide **contar contra lo asentado**, en dos momentos:

**Al recibir** — en la pestaña *Recepción*, *Validar recepción* abre el lote
carpeta por carpeta con lo capturado ya prellenado. Quien valida corrige solo
lo que no cuadre. Queda registrado quién validó, cuándo, y la diferencia exacta
contra lo asentado.

**Al entregar** — en la pestaña *Devolución*, *Cotejar devolución* hace lo
mismo con lo que se devuelve, caja por caja y con la situación de cada carpeta,
para confirmar que sale lo mismo que entró y en las mismas condiciones. Solo se
abre cuando todas las carpetas están recosidas y verificadas.

Las dos revisiones comparten dos reglas:

- **Si algo no coincide, hay que explicarlo.** El sistema no guarda un cotejo
  con diferencias sin una nota que diga a qué se deben. Si la nota falta, no se
  escribe nada: los números capturados no quedan a medias.
- **Sin cotejo no hay firma.** El acuse de devolución no se puede firmar hasta
  que la entrega esté cotejada. El botón aparece desactivado.

Ambos cotejos salen impresos: el de recepción como constancia al pie del acuse,
y el de entrega como dos columnas —*Recibido* y *Devuelto*— en el acuse de
devolución, con las diferencias marcadas y los totales de cada lado.

### Devolución y punto de aceptación

Un lote **solo se devuelve cuando todas sus carpetas están recosidas y
verificadas**, con sus insertos reintegrados. Hasta entonces la pestaña dice
cuántas faltan.

En la pestaña *Devolución* se cierra el ciclo: fecha, quién entrega de nuestra
parte, quién recibe en la dependencia, el medio por el que se entregan las
imágenes (disco duro, USB, nube, DVD o servidor del cliente), cuántos archivos
se entregaron y el **punto de aceptación**: Aceptado, Aceptado con
observaciones, o Rechazado, con sus observaciones.

De ahí sale el **acuse de devolución**, que en una hoja reúne lo devuelto en
papel, lo entregado en digital, todas las incidencias del servicio y las dos
firmas. Una vez firmado, los datos de la devolución quedan cerrados. Si la
dependencia **rechaza** la entrega, el lote no se marca como devuelto: las
carpetas siguen en resguardo. Cancelar una devolución registrada lo puede hacer
solo un supervisor, y el historial guarda los datos que tenía.

### Historial

Cada lote guarda una bitácora de auditoría propia: recepción, ediciones (con
**el antes y el después de cada campo**), validación, cada paso de cada carpeta,
incidencias, solicitudes, firmas y devolución — cada movimiento con su fecha,
hora y la persona que lo hizo. El panel muestra esa misma actividad de toda la
operación. También quedan registrados los cambios de ajustes, de mesas, las
bajas de personal y cada exportación del CSV.

**La auditoría no se puede borrar ni modificar**: lo impide la propia base de
datos, no solo el programa.

## Sedes, mesas y traslados

El sistema trabaja con **varias sedes**, cada una con sus propias mesas (cada
sede puede tener su «Mesa 1», «Mesa 2»…). Lo que existía antes de haber sedes
quedó en la **Sede principal**. Las sedes y las mesas las administra un
supervisor en *Personal*.

**Cada carpeta sabe dónde está físicamente:** en qué sede, en qué mesa, o si va
**en tránsito** entre dos sedes. Se ve en la columna *Dónde está* de la pestaña
*Digitalización* de cada lote.

**Quién ve qué:**

- **Supervisor**: todas las sedes.
- **Recepción y Operador**: solo lo de **su sede**. Ven un lote si se recibió
  ahí, si tiene cajas ahí o si viene en camino hacia ahí, y solo trabajan las
  carpetas que están físicamente en su sede.
- **Mesa**: un rol para el personal de digitalización. Cada persona entra con su
  propia cuenta y un supervisor la asigna a una mesa. **Solo ve
  *Digitalización* con las carpetas asignadas a su mesa**, y solo puede
  descoserlas, escanearlas, recoserlas y reportar incidencias. No asigna, no
  recibe, no ve listas ni cifras generales. Cada paso queda a su nombre.

**Traslados entre sedes.** Las cajas se mueven **completas** con un traslado
formal, desde la tarjeta *Traslados entre sedes* de *Digitalización*:

1. **Enviar cajas a otra sede**: se eligen las cajas, la sede destino y **quién
   las transporta** (obligatorio). Solo salen cajas de lotes validados y sin
   carpetas a medio tratamiento en una mesa.
2. Mientras viajan, las carpetas aparecen **en tránsito** y **nadie las puede
   trabajar ni asignar**.
3. **Recibir**: solo la sede destino. Cuenta cada caja (carpetas y fojas) **sin
   datos precargados**. Si algo no coincide con lo que salió, hay que explicarlo,
   y la diferencia queda en el historial de cada lote.

Una carpeta solo se asigna a una mesa de la sede donde está. Para devolver un
lote, todas sus cajas tienen que estar en una misma sede y ninguna en tránsito.

El reporte diario y las cifras del Panel se limitan a la sede de quien los
consulta; el trabajo de mesa se cuenta en la sede de la mesa.

## Expedientes digitales y NAS

Cada carpeta escaneada lleva **un PDF con todas sus hojas en orden**:

- **Se sube al registrar el escaneo** (o después, con *Subir PDF*). Sus páginas
  tienen que coincidir con las imágenes reportadas; si no, se rechaza.
- **Sin PDF no se recose** la carpeta.
- De cada PDF se registra quién lo subió, cuándo, su tamaño, sus páginas y su
  **huella SHA-256**. *Verificar* (supervisores) recalcula la huella y confirma
  que el archivo no cambió desde que se subió.
- **Nada se sobrescribe**: si se vuelve a escanear, el nuevo PDF exige un motivo
  y el anterior se conserva como versión previa.
- Se consultan en la sección **Expedientes** (asignable por persona, como las
  demás). **Cada vez que alguien abre un PDF queda en el historial del lote.**
  Una mesa puede abrir solo los de su mesa.

Se guardan ordenados como `sede/lote/NUC.pdf` dentro de la carpeta indicada en
`BITACORA_ARCHIVO` (por omisión `data/archivo`; en modo de prueba
`data/archivo-prueba`). Tamaño máximo por archivo: `BITACORA_ARCHIVO_MAX_MB`
(por omisión 1024).

### Conectar una NAS

1. En la NAS, crea una carpeta compartida (por ejemplo `expedientes`) a la que
   **solo tenga acceso la cuenta del servidor** de la Bitácora. Las personas
   consultan a través de la Bitácora, que registra cada consulta.
2. Móntala en el equipo que corre la Bitácora:
   - macOS: Finder → *Ir* → *Conectarse al servidor* → `smb://IP-DE-LA-NAS/expedientes`
     (queda en `/Volumes/expedientes`). Conviene agregarla a *Ítems de inicio*
     para que se monte sola.
   - Linux: una línea en `/etc/fstab` con `cifs` o `nfs`.
3. Crea dentro una subcarpeta para la Bitácora y apúntala:
   ```bash
   BITACORA_ARCHIVO=/Volumes/expedientes/bitacora npm start
   ```
   Al arrancar, la consola muestra la carpeta de expedientes y avisa si **no está
   disponible**.

**Si la NAS se desconecta**, la Bitácora no guarda los PDF en otro lado: rechaza
la subida con un aviso. Por eso apúntala a una **subcarpeta** dentro del recurso
compartido y no al punto de montaje mismo.

Recomendaciones para la NAS: discos en espejo (RAID), **instantáneas
(snapshots)** que no se puedan borrar desde la red, y respaldo a otro equipo. Los
respaldos diarios de la Bitácora copian la base de datos, **no los PDF**.

Si la Bitácora se publica en internet, no podrá llegar a una NAS de la red local
salvo con una conexión privada (VPN). Para expedientes de este tipo, lo más
directo es un servidor en la red local.

## Panel: de la cifra al detalle

Arriba del Panel se elige el **periodo**: *Hoy*, *Últimos 3 días*, *Última
semana*, *Últimas 2 semanas*, *Este mes* o *Personalizado* (dos fechas). El
periodo cambia las cifras de actividad (recepciones, fojas, imágenes y
producción por responsable de mesa) y los listados a los que llevan. Las
cifras de estado (lotes en proceso, incidencias abiertas, carpetas acumuladas)
son siempre las de este momento. El Reporte usa el mismo periodo.

Todo en el Panel se puede pulsar para ver lo que hay detrás:

| En el Panel | Lleva a |
|---|---|
| Recepciones · Fojas | Las carpetas recibidas en el periodo |
| Imágenes | Las carpetas escaneadas en el periodo |
| Lotes en proceso | La Bitácora con los lotes recibidos o en digitalización |
| Incidencias abiertas | Las incidencias, abiertas o todas |
| Carpetas acumuladas | Todas las carpetas, con búsqueda y filtros por situación y etapa |
| Estado de los lotes | La Bitácora filtrada por ese estado |
| Situación de los documentos | Las carpetas en esa situación |
| Dependencias | La Bitácora de esa dependencia |
| Producción por responsable | Las carpetas que escaneó esa mesa |
| Actividad reciente | El lote del movimiento |

En cada listado, un clic en un renglón abre el lote. Los listados respetan la
sede de quien consulta. «Hoy» es el día en la hora local del equipo.

## Reporte por periodo

En el Panel, **Reporte** muestra lo que se hizo en cada etapa del proceso
durante el periodo elegido (un día, los últimos 3 días, la semana, dos semanas,
el mes o un rango propio), con sus indicadores, y se puede **imprimir**. Todo
sale de lo ya registrado: no hay que capturar nada aparte.

| Etapa | Indicadores | Desglose |
|---|---|---|
| 1. Recepción | Lotes, cajas, carpetas y fojas recibidas; recepciones canceladas | Por lote y por quién recibió |
| 2. Validación | Lotes validados, carpetas contadas, **carpetas con diferencia** | Por quién validó |
| 3. Asignación a mesas | Carpetas asignadas, **reasignadas** (volvieron a mesa) | Por mesa y responsable |
| 4. Descosido y revisión | Carpetas descosidas, fojas revisadas, insertos retirados | Por persona y por tipo de inserto |
| 5. Escaneo | Carpetas y fojas escaneadas, imágenes, imágenes por foja, **escaneos incompletos**, **% de reproceso**, tiempo promedio en mesa | Por mesa |
| 6. Reintegración y recosido | Carpetas terminadas, insertos reintegrados, **ciclo promedio** (de la llegada a la mesa a quedar terminada) | Por persona |
| 7. Devolución | Lotes y carpetas devueltas, imágenes entregadas, aceptadas, con observaciones, **rechazadas**, **carpetas con diferencia al cotejar** | Por lote |
| 8. Incidencias | Reportadas, de gravedad alta, resueltas, anuladas, abiertas en total | Por tipo |

Los indicadores que señalan un problema (diferencias, reproceso, rechazos,
incidencias altas) se resaltan cuando son mayores que cero. El día se mide en la
hora local del equipo que consulta.

## Nada se borra: cancelación, correcciones y eliminación

No existe el botón «Eliminar». En la pestaña *Recepción* de cada lote, la
tarjeta **Cambios a la recepción** explica qué se puede hacer en ese momento:

- **Editar** la recepción se permite mientras no esté validada ni firmada.
  Cada carpeta conserva su identidad al editarse, y el historial guarda qué
  cambió.
- Una vez validada o firmada, para cambiarla hay que **solicitar una
  corrección**. Si un supervisor la aprueba, se puede editar una sola vez; al
  guardar se anulan la firma y la validación, y hay que volver a hacerlas.
- **Cancelar la recepción** (Recepción o Supervisor) pide un motivo y deja el
  lote como *Cancelado*, visible y sin cambios posibles. Solo se puede mientras
  ninguna carpeta haya entrado a digitalización.
- **Solicitar eliminación** sirve para capturas duplicadas o hechas por error.
  Si un supervisor la aprueba, el lote deja de aparecer en las listas y en las
  cifras, pero **se conserva completo, con su historial**. Los supervisores lo
  pueden consultar con el filtro *Eliminadas* de la Bitácora.
- Una vez que las carpetas entraron a digitalización, los datos de la recepción
  ya no se modifican por ninguna vía: cualquier hallazgo va como incidencia.

**Toda solicitud la resuelve un supervisor distinto de quien la pidió.** Las
pendientes aparecen en el Panel de los supervisores.

Además, la base de datos misma tiene candados: rechaza borrar remisiones,
incidencias, insertos, pasos por mesa, solicitudes o la auditoría, y rechaza
quitar una carpeta que ya entró a digitalización.

## Secciones que puede ver cada persona

Al dar de alta o editar a una persona (*Personal*), además del rol se marcan
**las secciones que puede ver**: Panel, Recepción, Digitalización, Devueltas,
Personal, Bitácora y Reporte del día. Al elegir el rol se proponen sus
secciones y el supervisor las ajusta.

| Rol | Secciones que se proponen |
|---|---|
| Recepción | Panel, Recepción, Digitalización, Devueltas, Bitácora, Reporte (Expedientes se da aparte) |
| Operador | Panel, Digitalización, Devueltas, Bitácora, Reporte |
| Mesa | Solo Digitalización, con su mesa (**fijo**) |
| Supervisor | Todas (**fijo**, para que nadie se quede sin acceso a la administración) |

El menú solo muestra las secciones permitidas y la persona entra directo a la
primera. **El servidor también lo hace cumplir**: sin la sección, sus datos no
se pueden consultar ni modificar aunque se escriba la dirección a mano. Por
ejemplo, sin *Recepción* no se capturan ni validan recepciones; sin
*Devueltas* no se registra ni se coteja una devolución. Cada cambio de
secciones queda en el historial.

## Permisos por rol

| Acción | Mesa | Recepción | Operador | Supervisor |
|---|:---:|:---:|:---:|:---:|
| Descoser y preparar (solo su mesa) | ✔ | ✔ | ✔ | ✔ |
| Escanear y subir PDF (en la mesa, solo su escaneador) | ✔ | ✔ | ✔ | ✔ |
| Recoser (en la mesa, solo quien la descosió) | ✔ | ✔ | ✔ | ✔ |
| Reasignar el recosido | | | | ✔ |
| Reportar incidencias | ✔ | ✔ | ✔ | ✔ |
| Recibir, validar, asignar a mesa, devolver (su sede) | | ✔ | ✔ | ✔ |
| Enviar y recibir traslados (su sede) | | ✔ | ✔ | ✔ |
| Cancelar una recepción | | ✔ | | ✔ |
| Solicitar corrección o eliminación | | ✔ | ✔ | ✔ |
| Ver todas las sedes | | | | ✔ |
| Aprobar o rechazar solicitudes (de otros) | | | | ✔ |
| Sedes, mesas, ajustes, alta y baja de personal | | | | ✔ |
| Exportar CSV y descargar respaldos | | | | ✔ |
| Cancelar una devolución registrada | | | | ✔ |

## Uso diario

1. **Recepción** — captura la entrega. Los campos de dependencia, personas,
   cargos autocompletan con lo ya capturado.
   Agrega una caja por cada caja física y, dentro, una carpeta por cada carpeta con sus fojas.
   `⌘S` / `Ctrl+S` guarda.
2. **Bitácora** — busca por folio, dependencia, persona o descripción; filtra por
   estado y por rango de fechas. Al hacer clic en una fila se abre el detalle.
3. **Devueltas** — qué sigue en resguardo, cuántos días lleva y qué acuses faltan.
4. **Personal** — da de alta a quienes reciben y digitalizan antes de la primera
   recepción; el formulario los ofrece en una lista.
5. **Digitalización** — el trabajo de todas las mesas: qué falta validar, qué
   carpetas esperan mesa (se seleccionan y se asignan de una vez) y, por cada
   mesa, sus carpetas con el siguiente paso.
6. **Detalle** — cinco pestañas: *Recepción* (datos, validación, acuse,
   etiquetas, firma y cambios), *Digitalización* (cada carpeta, paso por paso),
   *Incidencias*, *Devolución* e *Historial*.
7. **Panel** — recepciones, fojas e imágenes del día, lotes pendientes,
   incidencias abiertas, acumulado histórico, desglose por dependencia y por
   situación física, producción por responsable de mesa, actividad reciente y,
   para supervisores, las solicitudes por resolver.
8. **Exportar CSV** (solo supervisores) — descarga lo que esté filtrado, una
   fila por carpeta con su NUC, folios y fechas de cada paso, listo para Excel.
   Cada exportación queda en la auditoría.

## Acuse, firma y etiquetas

Desde el detalle de cualquier remisión:

- **Firmar acuse** — abre una tableta donde quien entrega y quien recibe firman
  con el dedo, el ratón o un lápiz digital. Las firmas quedan guardadas junto
  con la fecha y hora, y se imprimen en el acuse.
- **Imprimir acuse** — hoja con el folio, su código QR, el desglose de carpetas
  por caja con totales, las observaciones, la leyenda de conformidad y los espacios de
  firma. Si aún no está firmado, se imprime en blanco para firma a mano.
- **Imprimir etiquetas** — una etiqueta por caja (`Caja 1 de 4`, `Caja 2 de 4`…),
  cada una con el folio, el QR, la dependencia y los totales. Pégalas en los
  bultos para rastrearlos.

El QR contiene el folio en texto plano: cualquier teléfono lo lee sin
aplicación especial y el resultado se pega en el buscador de la bitácora.

**Sobre la firma.** Es una firma autógrafa capturada en pantalla, equivalente a
firmar el acuse impreso: sirve como constancia de la entrega, no es una firma
electrónica avanzada (e.firma). Si se edita una remisión ya firmada, las firmas
se anulan automáticamente, porque dejarían de corresponder al contenido del
acuse.

El nombre de la organización, el prefijo del folio y la leyenda del acuse se
cambian en **Ajustes**, en la barra lateral.

Si cambias el prefijo, los folios
ya emitidos se conservan tal cual y la numeración arranca de nuevo en la serie
nueva; conviene definirlo antes de la primera recepción.

## Publicarlo en internet

El sistema puede vivir fuera de la oficina: se llega desde cualquier lado, tiene
HTTPS y el acceso con Google funciona sin las restricciones de la red local.

**No hace falta comprar un dominio para empezar.** Los servicios de hospedaje
dan una dirección propia con HTTPS incluido —`tuapp.fly.dev`,
`tuapp.up.railway.app`, `tuapp.onrender.com`— y Google acepta esas direcciones
como URI de redireccionamiento. Con eso el acceso con Google funciona desde el
primer día. El dominio propio se puede agregar después sin mover nada más. El sistema ya está listo para eso —
`Dockerfile`, `fly.toml`, señal de vida en `/salud` y cierre ordenado ante
`SIGTERM`.

**Lo único que necesita disco es la base y los respaldos**, así que hay que
montar un volumen; sin él, cada despliegue empezaría de cero.

### Con Fly.io

```bash
brew install flyctl
fly auth login
fly launch --no-deploy          # reconoce el Dockerfile y el fly.toml
fly volumes create datos --size 1 --region dfw
fly deploy
fly scale count 1               # una sola máquina: la base no se comparte
```

Luego el dominio y las credenciales:

```bash
fly certs add bitacora.tudominio.com
fly secrets set \
  BITACORA_URL="https://bitacora.tudominio.com" \
  GOOGLE_CLIENT_ID="...apps.googleusercontent.com" \
  GOOGLE_CLIENT_SECRET="..."
```

`fly certs add` dice qué registros DNS crear en el proveedor del dominio; el
certificado se emite y se renueva solo. En Google Cloud, la URI de
redireccionamiento es `https://bitacora.tudominio.com/auth/google/callback`.

Los secretos se guardan en Fly, nunca en el repositorio.

### Otras opciones

Railway y Render sirven igual: reconocen el `Dockerfile`, dan HTTPS y permiten
montar un volumen en `/datos`. Un VPS también, agregando un proxy con
certificado. Lo que **no** funciona es un servicio sin disco persistente
(Vercel, Netlify o las funciones Edge de Supabase): la base quedaría en
memoria y se perdería en cada despliegue.

### Antes de exponerlo

- Deja el acceso con Google activo: es lo que separa el sistema de internet.
- Descarga un respaldo con cierta regularidad a un disco propio; el volumen del
  proveedor no es tuyo.
- Recuerda que la bitácora contiene datos de custodia de dependencias
  (nombres, firmas, inventarios), aunque no los documentos.

## Datos y respaldo

Todo vive en `data/bitacora.db`.

El sistema crea **una copia automática al día** en `respaldos/`, la primera vez
que arranca cada jornada, y conserva las 30 más recientes. El panel muestra la
fecha de la última copia, permite generar una en el momento con *Respaldar
ahora* y **descargarla** — que es la manera de tener el respaldo en un disco
propio cuando el sistema está alojado fuera. Cada copia es una base completa: para restaurar, detén el servidor y
copia el archivo sobre `data/bitacora.db`.

```bash
cp respaldos/bitacora-2026-08-27-0900.db data/bitacora.db
```

Las copias viven en el mismo disco, así que protegen contra un error de captura
o un borrado accidental, no contra la pérdida del equipo. Para eso, sincroniza
la carpeta `respaldos/` a un disco externo o a la nube:

```bash
rsync -a respaldos/ /Volumes/Respaldo/bitacora/
```

Variables opcionales: `BITACORA_RESPALDOS` (carpeta destino) y
`BITACORA_RESPALDOS_CONSERVAR` (cuántas copias guardar).

Para empezar de cero con la base de **prueba**, detén el servidor y borra
`data/prueba.db*`. La base real no se debería reiniciar nunca: si hace falta,
guárdala antes en un lugar seguro.

## API

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/remisiones?q=&estado=&desde=&hasta=` | Listado filtrado |
| POST | `/api/remisiones` | Crear remisión con sus cajas y carpetas |
| GET | `/api/remisiones/:id` | Detalle |
| PUT | `/api/remisiones/:id` | Editar (solo si está libre o con corrección autorizada) |
| POST | `/api/remisiones/:id/cancelacion` | Cancelar la recepción, con motivo |
| POST | `/api/remisiones/:id/solicitudes` | Solicitar corrección o eliminación |
| GET | `/api/solicitudes` | Solicitudes pendientes (supervisores) |
| PUT | `/api/solicitudes/:id` | Aprobar o rechazar (otro supervisor) |
| GET | `/api/nuc?valor=` | Lotes donde ya aparece un NUC |
| GET | `/api/reporte?desde=&hasta=&desfase=` | Reporte por etapa de un periodo (o `fecha=` para un día) |
| GET | `/api/estadisticas?desde=&hasta=&desfase=` | Cifras del Panel para un periodo |
| GET | `/api/carpetas?desde=&hasta=&escaneadas_desde=&escaneadas_hasta=&situacion=&etapa=&q=&responsable=&con_archivo=` | Listado de carpetas con su etapa, ubicación y PDF |
| GET | `/api/incidencias?estado=Abierta` | Listado de incidencias (sin las anuladas) |
| POST | `/api/remisiones/:id/carpetas/:carpeta/archivo?nombre=&motivo=` | Subir el PDF de una carpeta (cuerpo: el PDF) |
| GET | `/api/archivos/:id` | Abrir un PDF (queda registrado) |
| GET | `/api/archivos/:id/verificacion` | Recalcular su huella SHA-256 (supervisores) |
| GET | `/api/digitalizacion` | Trabajo pendiente de las mesas (de la sede o de la mesa de quien consulta) |
| GET · POST | `/api/sedes` | Sedes |
| PUT | `/api/sedes/:id` | Cambiar nombre o desactivar una sede |
| GET · POST | `/api/traslados` | Traslados de la sede, o enviar cajas a otra |
| PUT | `/api/traslados/:id/recepcion` | Recibir un traslado contando cada caja |
| GET | `/api/sugerencias` | Catálogos y autocompletado |
| GET | `/api/exportar.csv` | Exportación (supervisores) |
| POST | `/api/remisiones/:id/firma` | Firmar el acuse de recepción (una vez) |
| GET · PUT | `/api/config` | Nombre de la organización y leyenda del acuse |
| GET · POST | `/api/respaldos` | Listar o crear copias de respaldo |
| GET | `/api/respaldos/:archivo` | Descargar una copia (solo supervisores) |
| GET | `/salud` | Señal de vida para el servicio que lo aloja |
| GET | `/api/dependencias` | Dependencias y sus enlaces |
| POST · PATCH | `/api/dependencias/:id` | Regenerar el enlace o desactivarlo |
| GET | `/tablero/:llave` | Tablero público de una dependencia |
| GET | `/api/tablero/:llave` | Datos del tablero (solo lectura, sin sesión) |
| GET | `/api/sesion` | Modo de acceso y sesión actual |
| GET | `/auth/google` | Inicia el acceso con Google |
| GET | `/auth/google/callback` | Regreso de Google; abre la sesión |
| POST | `/auth/salir` | Cierra la sesión |
| GET · POST | `/api/usuarios` | Personas del equipo |
| PUT · DELETE | `/api/usuarios/:id` | Cambiar rol, sede, mesa y secciones, o dar de baja (no se borra) |
| GET · POST | `/api/mesas` | Mesas de digitalización |
| PUT | `/api/mesas/:id` | Cambiar nombre, escaneador o desactivar |
| POST | `/api/remisiones/:id/carpetas/:doc/reasignacion` | Reasignar el recosido a otra persona de la mesa (supervisor) |
| POST | `/api/remisiones/:id/carpetas/:carpeta/preparacion` | Descosido, revisión e insertos |
| POST | `/api/remisiones/:id/mesa` | Enviar carpetas preparadas a una mesa |
| POST | `/api/remisiones/:id/carpetas/:carpeta/escaneo` | Fojas escaneadas e imágenes |
| POST | `/api/remisiones/:id/carpetas/:carpeta/recosido` | Reintegración de insertos y recosido |
| POST | `/api/remisiones/:id/incidencias` | Reportar una incidencia |
| PATCH | `/api/incidencias/:id` | Resolver o anular |
| PUT | `/api/remisiones/:id/validacion` | Validar la recepción carpeta por carpeta |
| PUT | `/api/remisiones/:id/cotejo` | Cotejar la devolución contra lo recibido |
| PUT · DELETE | `/api/remisiones/:id/devolucion` | Registrar o cancelar la devolución |
| POST | `/api/remisiones/:id/devolucion/firma` | Firmar el acuse de devolución |
| GET | `/api/eventos` | Bitácora de auditoría |

La identidad sale siempre de la sesión: la API responde `401` sin ella y `503`
si el acceso no está configurado. Lo que el navegador diga sobre quién hace algo
se ignora. Las reglas del proceso que no se cumplen responden `400` con la
explicación.

## Archivos

```
server.js          servidor HTTP y API
db.js              esquema SQLite, migraciones, catálogos, folios, auditoría
respaldo.js        copias automáticas y manuales
auth.js            acceso con Google (OAuth 2.0 + PKCE) y sesiones
custodia.js        cadena de custodia de cada carpeta, mesas, cancelación y solicitudes
reporte.js         reporte por periodo con los indicadores de cada etapa
archivo.js         expedientes digitales: guardar, contar páginas, abrir y verificar PDF
public/index.html  estructura de la interfaz
public/styles.css  diseño (claro y oscuro, móvil, impresión)
public/app.js      lógica de la interfaz
public/acuse.js    acuses de recepción y devolución, etiquetas, firmas
public/qr.js       generador de códigos QR (sin dependencias)
public/tablero.*   tablero público de la dependencia
data/bitacora.db   base de datos
respaldos/         copias diarias
Dockerfile         imagen para publicarlo en internet
fly.toml           despliegue en Fly.io, con volumen y señal de vida
```

El generador de QR se verificó decodificando 200 códigos con el lector de
macOS, en las seis versiones que soporta.
