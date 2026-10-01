# PROYECTAI

Bitácora de digitalización de documentos. Registra la recepción y el
seguimiento de los documentos que entran a digitalización: quién entrega, quién
recepciona, de qué dependencia, cuántos documentos, cuántas fojas y en qué
situación se reciben; el avance de la captura, las incidencias del servicio y
la devolución con su punto de aceptación.

## Requisitos

Solo Node.js 24 o superior. No hay dependencias externas: la base de datos es
SQLite integrado en Node (`node:sqlite`, que deja de ser experimental en la 24)
y la interfaz es HTML, CSS y JS puros.

## Qué guarda y qué no

PROYECTAI es **la bitácora, no el acervo**: registra quién entregó qué, en qué
estado, quién lo digitalizó y cómo se devolvió. **No almacena los documentos
digitalizados** — no hay forma de subir un archivo al sistema, y las imágenes
siguen viviendo donde ustedes decidan. Lo único binario que guarda son las
firmas de los acuses.

Por eso la base es diminuta: unos 2 KB por remisión, o 90 KB si lleva las
cuatro firmas. Mil remisiones al año caben en 90 MB.

## Arrancar

```bash
npm start
```

Al iniciar, la consola imprime dos direcciones:

```
PROYECTAI · Bitácora  ·  este equipo:  http://localhost:4321
                      ·  en la red:    http://192.168.68.124:4321
```

La primera es para el equipo donde corre el sistema. **La segunda es la que se
abre desde los demás equipos de la oficina** — computadoras, tabletas o
teléfonos — en cualquier navegador. No hay que instalar nada en ellos.

Para que funcione: el equipo servidor debe estar encendido, en la misma red, y
macOS debe permitir conexiones entrantes a Node (la primera vez aparece un
aviso del cortafuegos; hay que aceptarlo). Si la IP del equipo cambia, la
dirección cambia con ella; conviene pedirle al router una IP fija.

Para cambiar el puerto: `PORT=8080 npm start`.

## Acceso con Google

PROYECTAI puede funcionar de dos maneras (más una entrada de prueba para
conocerlo, descrita enseguida):

- **Modo local** (por omisión) — sin contraseñas. Cada equipo declara quién lo
  usa y eso queda asentado en el historial. Sirve dentro de una oficina de
  confianza; la identidad no está verificada.
- **Acceso con Google** — cada persona entra con su cuenta de Google y solo
  pueden entrar los correos dados de alta. La identidad queda verificada.

El segundo se activa en cuanto existen las credenciales de Google.

### Probarlo antes de configurar Google

Para conocer el sistema con sesiones reales sin haber creado todavía las
credenciales:

```bash
npm run prueba
```

Arranca con una **entrada de prueba**: la pantalla de acceso ofrece tres
cuentas ficticias —Supervisor, Operador y Recepción— para entrar con un clic y
ver cómo cambia el sistema según el rol. Dentro aparece un aviso permanente de
que estás en modo de prueba.

Lo que sí es real: todo lo que registres se guarda de verdad en la base, y el
historial atribuye cada movimiento a la cuenta de prueba con la que entraste.

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

1. Crea un proyecto (por ejemplo *PROYECTAI*).
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

## Entregas

La vista **Entregas** es el registro de las carpetas: qué está en nuestro poder
y qué ya se devolvió. Tiene tres pestañas —*En resguardo*, *Entregadas* y
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
es lo que falta para poder firmar el acuse. Si la devolución se cancela después,
el lote **regresa al estado que le corresponde** según su avance de captura: no
se queda marcado como devuelto estando en resguardo.

## Tablero para la dependencia

Cada dependencia puede consultar el avance de **sus** documentos desde un
enlace propio, sin cuenta ni contraseña. En el panel, la tarjeta *Dependencias*
tiene un botón **Tablero** por cada una: ahí se copia el enlace, se genera uno
nuevo o se desactiva.

El tablero muestra, del lado de la dependencia: cuántas entregas ha hecho, con
cuántos documentos, fojas y cajas; cuántas imágenes se han generado y qué
porcentaje representan; y la lista de sus lotes con **la fecha en que se
recibió cada uno y el estado en que va**. Al abrir un lote se ven sus partidas,
las incidencias que le afectan y los datos de su devolución.

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
vistazo lo que ha hecho: **recepciones atendidas, sesiones de captura, imágenes
generadas y su última actividad**.

El cargo importa porque es el que se imprime en los acuses junto a la firma.

En el formulario de recepción, **quién recibe se elige de este padrón** en vez
de escribirse a mano, y el cargo se llena solo. Así el dato queda consistente y
los contadores cuadran. Para casos sueltos —alguien que recibe una sola vez—
está la opción *Otra persona…*, que abre un campo libre.

Dos detalles pensados para no perder historial:

- **Corregir un nombre arrastra su historial.** Si alguien quedó registrado como
  «Luis Pech» y en realidad es «Luis Pech Canul», al corregirlo se actualizan
  también sus capturas, incidencias, recepciones y eventos. No quedan dos
  personas donde hay una.
- **Quien ya trabajó no se puede borrar.** El sistema lo impide y pide marcarla
  como baja: deja de aparecer en los selectores, pero su historial permanece
  intacto.

### Quién usa cada equipo

Abajo de la barra lateral (o en la barra inferior en el teléfono) está el
selector de persona. Cada equipo se identifica una vez y el navegador lo
recuerda; a partir de ahí **todo lo que se registre desde ahí queda a nombre de
esa persona**, y se ve en el historial de cada lote y en la actividad reciente.

Las personas se dan de alta desde ese mismo selector, con su rol (Recepción,
Operador o Supervisor).

> **Sobre la seguridad.** En modo local no hay contraseñas: cualquiera que
> alcance la dirección en la red puede consultar y registrar, y la identidad es
> declarada, no verificada. Para verificarla, activa el **acceso con Google**
> (más abajo). En cualquiera de los dos modos, no expongas el sistema a
> internet sin HTTPS.

## Qué se registra

**Por remisión (la entrega física de un lote)**

| Campo | Descripción |
|---|---|
| Folio | Automático y consecutivo por año: `CTS-2026-0001`. El prefijo se define en Ajustes |
| Cajas o paquetes | Cuántos bultos ampara la remisión (define cuántas etiquetas se imprimen) |
| Carpetas | Cuántas carpetas vienen en la entrega |
| Fecha y hora | Momento de la recepción |
| Dependencia / Área | Origen de los documentos |
| Quién entrega | Nombre y cargo |
| Quién recepciona | Nombre y cargo |
| Estado del lote | Recibido → En digitalización → Digitalizado → Devuelto |
| Observaciones | Condiciones de la entrega, faltantes, acuerdos |

**Por partida (cada tipo de documento dentro del lote)**

Descripción, tipo documental, cantidad de documentos, número de fojas,
situación en que se entrega (buen estado, deteriorado, incompleto, húmedo o
manchado, roto o frágil, empastado, con grapas o clips, foliado, sin foliar) y
observaciones propias.

Los totales de documentos, fojas y partidas se calculan solos.

## El ciclo completo de un lote

Cada remisión pasa por cuatro etapas, y el sistema las va marcando solo:

| Etapa | Cuándo cambia |
|---|---|
| **Recibido** | Al registrar la recepción |
| **En digitalización** | Cuando alguien inicia la primera sesión de captura |
| **Digitalizado** | Cuando se cierra la última sesión de captura abierta |
| **Devuelto** | Al registrar la devolución con su punto de aceptación |

El estado también se puede mover a mano desde el detalle del lote.

### Digitalización

En la pestaña *Digitalización* del lote:

- **Iniciar captura** deja constancia de que una persona empezó a digitalizar,
  con la hora exacta. Varias personas pueden tener sesiones abiertas sobre el
  mismo lote.
- **Finalizar** cierra la sesión y pide cuántas imágenes se generaron, más
  notas opcionales.

Con eso el sistema calcula el tiempo trabajado, el ritmo por hora y —lo más
útil para el control de calidad— **las imágenes generadas contra las fojas
recibidas**: si no cuadran, se ve de inmediato.

### Incidencias

En la pestaña *Incidencias* se registra cualquier problema del servicio:
faltantes respecto al inventario, documentos en mal estado o ilegibles, daños
ocurridos en el proceso, errores de foliación, fallas de equipo o documentos
fuera de orden. Cada una lleva gravedad (baja, media, alta), quién la reportó y
cuándo.

Una incidencia queda **Abierta** hasta que se registra cómo se resolvió. Los
lotes con incidencias abiertas se marcan en la lista de la bitácora y en el
panel, y todas las incidencias —abiertas y resueltas— aparecen en el acuse de
devolución.

### Cotejo: validar lo que se recibe y lo que se entrega

El sistema pide **contar contra lo asentado**, en dos momentos:

**Al recibir** — en la pestaña *Recepción*, *Validar recepción* abre el lote
partida por partida con lo capturado ya prellenado. Quien valida corrige solo
lo que no cuadre. Queda registrado quién validó, cuándo, y la diferencia exacta
contra lo asentado.

**Al entregar** — en la pestaña *Devolución*, *Cotejar entrega* hace lo mismo
con lo que se devuelve, para confirmar que sale lo mismo que entró.

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

En la pestaña *Devolución* se cierra el ciclo: fecha, quién entrega de nuestra
parte, quién recibe en la dependencia, el medio por el que se entregan las
imágenes (disco duro, USB, nube, DVD o servidor del cliente), cuántos archivos
se entregaron y el **punto de aceptación**: Aceptado, Aceptado con
observaciones, o Rechazado, con sus observaciones.

De ahí sale el **acuse de devolución**, que en una hoja reúne lo devuelto en
papel, lo entregado en digital, todas las incidencias del servicio y las dos
firmas. Corregir los datos de la devolución anula sus firmas, igual que en el
acuse de recepción.

### Historial

Cada lote guarda una bitácora de auditoría propia: recepción, cambios de
estado, inicios y fines de captura, incidencias, firmas y devolución — cada
movimiento con su fecha, hora y la persona que lo hizo. El panel muestra esa
misma actividad de toda la operación.

## Uso diario

1. **Recepción** — captura la entrega. Los campos de dependencia, personas,
   cargos y tipos documentales autocompletan con lo ya capturado.
   Agrega una partida por cada grupo de documentos con fojas o situación distinta.
   `⌘S` / `Ctrl+S` guarda.
2. **Bitácora** — busca por folio, dependencia, persona o descripción; filtra por
   estado y por rango de fechas. Al hacer clic en una fila se abre el detalle.
3. **Entregas** — qué sigue en resguardo, cuántos días lleva y qué acuses faltan.
4. **Personal** — da de alta a quienes reciben y digitalizan antes de la primera
   recepción; el formulario los ofrece en una lista.
5. **Detalle** — cinco pestañas: *Recepción* (datos, acuse, etiquetas, firma),
   *Digitalización* (sesiones de captura), *Incidencias*, *Devolución* e
   *Historial*.
6. **Panel** — recepciones, fojas e imágenes del día, lotes pendientes,
   incidencias abiertas, acumulado histórico, desglose por dependencia y por
   situación física, producción por operador y actividad reciente.
7. **Exportar CSV** — descarga lo que esté filtrado, una fila por partida,
   listo para Excel.

## Acuse, firma y etiquetas

Desde el detalle de cualquier remisión:

- **Firmar acuse** — abre una tableta donde quien entrega y quien recibe firman
  con el dedo, el ratón o un lápiz digital. Las firmas quedan guardadas junto
  con la fecha y hora, y se imprimen en el acuse.
- **Imprimir acuse** — hoja con el folio, su código QR, el desglose de partidas
  con totales, las observaciones, la leyenda de conformidad y los espacios de
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

**Logotipo.** Si existe `public/logo.png` (o `.svg`, o `.jpg`), el sistema lo
usa en la pantalla de acceso y en el membrete de los acuses. Si además existe
`public/logo-marca.png` —sólo el símbolo, sin el texto—, ésa se usa en la barra
lateral y en el membrete, donde el logotipo completo quedaría ilegible. Para
cambiarlos basta reemplazar los archivos; conviene que tengan fondo
transparente, porque en modo oscuro se invierten a blanco. Si cambias el prefijo, los folios
ya emitidos se conservan tal cual y la numeración arranca de nuevo en la serie
nueva; conviene definirlo antes de la primera recepción.

## Publicarlo en internet

PROYECTAI puede vivir fuera de la oficina: se llega desde cualquier lado, tiene
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
rsync -a respaldos/ /Volumes/RespaldoCTS/bitacora/
```

Variables opcionales: `BITACORA_RESPALDOS` (carpeta destino) y
`BITACORA_RESPALDOS_CONSERVAR` (cuántas copias guardar).

Para empezar de cero, detén el servidor y borra `data/bitacora.db*`.

## API

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/remisiones?q=&estado=&desde=&hasta=` | Listado filtrado |
| POST | `/api/remisiones` | Crear remisión con sus partidas |
| GET | `/api/remisiones/:id` | Detalle |
| PUT | `/api/remisiones/:id` | Reemplazar remisión y partidas |
| PATCH | `/api/remisiones/:id` | Cambiar solo el estado |
| DELETE | `/api/remisiones/:id` | Eliminar |
| GET | `/api/estadisticas` | Cifras del panel |
| GET | `/api/sugerencias` | Catálogos y autocompletado |
| GET | `/api/exportar.csv` | Exportación |
| POST | `/api/remisiones/:id/firma` | Guardar las firmas del acuse |
| DELETE | `/api/remisiones/:id/firma` | Anular las firmas |
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
| PUT · DELETE | `/api/usuarios/:id` | Cambiar rol o dar de baja |
| POST | `/api/remisiones/:id/capturas` | Iniciar una sesión de captura |
| PATCH · DELETE | `/api/capturas/:id` | Cerrar, corregir o quitar una sesión |
| POST | `/api/remisiones/:id/incidencias` | Reportar una incidencia |
| PATCH · DELETE | `/api/incidencias/:id` | Resolver o quitar |
| PUT | `/api/remisiones/:id/validacion` | Validar la recepción partida por partida |
| PUT | `/api/remisiones/:id/cotejo` | Cotejar la entrega contra lo recibido |
| PUT · DELETE | `/api/remisiones/:id/devolucion` | Registrar o cancelar la devolución |
| POST | `/api/remisiones/:id/devolucion/firma` | Firmar el acuse de devolución |
| GET | `/api/eventos` | Bitácora de auditoría |

Con el acceso de Google activo, la identidad sale de la sesión y la API
responde `401` sin ella. En modo local, las peticiones llevan la cabecera
`X-Usuario` con la persona declarada en ese equipo. En ambos casos es lo que
queda asentado en el historial.

## Archivos

```
server.js          servidor HTTP y API
db.js              esquema SQLite, migraciones, catálogos, folios, auditoría
respaldo.js        copias automáticas y manuales
auth.js            acceso con Google (OAuth 2.0 + PKCE) y sesiones
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
